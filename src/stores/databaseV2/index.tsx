import { DexieClient } from './clients/dexie'
import { FirestoreClient } from './clients/firestore'
import { RealtimeDBClient } from './clients/rtdb'
import {
  AbstractDatabase,
  DBClients,
  DBDoc,
  DBQueryWhereOperator,
  DBQueryWhereValue,
} from './types'

import { Observable, Observer } from 'rxjs'
import { DB_PREFIX } from './config'

/**
 * Consts and Types
 * A few additional exports are provided to help ensure type safety.
 * @remark - list required to populate db schema in dexie
 * @remark - Mapping required to allow custom prefix for any of the endpoints
 */
const endpoints = ['howtos', 'users', 'tags', 'events', 'mappins'] as const
export type DBEndpoint = typeof endpoints[number]
const mappedEndpoints = {} as { [key in DBEndpoint]: string }
endpoints.forEach(
  endpoint => (mappedEndpoints[endpoint] = `${DB_PREFIX}${endpoint}`),
)
export const DBEndpoints = mappedEndpoints

/**
 * Main Database class
 */
export class DatabaseV2 implements AbstractDatabase {
  private _clients: DBClients
  constructor(clients?: DBClients) {
    this._clients = clients ? clients : this._getDefaultClients()
  }

  /**
   * Provide a reference to a collection which can then be retrieved or used to
   * access specific documents.
   * @param endpoint - the name of the collection as found in the database
   */
  collection<T>(endpoint: DBEndpoint) {
    // use mapped endpoint to allow custom db endpoint prefixes
    const mappedEndpoint = DBEndpoints[endpoint]
    return new CollectionReference<T>(mappedEndpoint, this._clients)
  }

  /**
   * By default 3 databases are provided (cache, server, server-cache)
   * Additionally, a 'no-idb' search param can be provided to disable
   * cache-db entirely (triggered from dexie if not supported)
   */
  private _getDefaultClients = (): DBClients => {
    const serverDB = new FirestoreClient()
    const cacheDB = window.location.search.includes('no-cache')
      ? serverDB
      : new DexieClient()
    return {
      cacheDB,
      serverDB,
      serverCacheDB: new RealtimeDBClient(),
    }
  }
}

class CollectionReference<T> {
  constructor(private endpoint: string, private clients: DBClients) {}

  /**
   * Provide a reference to a document to perform operations, such as getting or setting data
   * @param docID - provide an id for a specific doc, or leave blank to generate a new one
   */
  doc(docID?: string) {
    return new DocReference<T>(this.endpoint, docID, this.clients)
  }

  // TODO - allow partial observer instead of onUpdate and add unsubscribe
  /**
   * Streaming a collection retrieves provides a stream where a collection is
   * continually emitted, first with documents already cached, and then in realtime
   * as data is updated on the server.
   * @param onUpdate - callback function triggered when data is received.
   * This is triggered with the full set of documents (existing + update)
   */
  stream(onUpdate: (value: (T & DBDoc)[]) => void) {
    const totals: any = {}
    const { cacheDB, serverDB, serverCacheDB } = this.clients
    const endpoint = this.endpoint
    const observer: Observable<(T & DBDoc)[]> = Observable.create(
      async (obs: Observer<(T & DBDoc)[]>) => {
        // 1. Emit cached collection
        const cached = await cacheDB.getCollection<T>(endpoint)
        totals.cached = cached.length
        obs.next(cached)
        if (cached.length === 0) {
          // 2. If no cache, populate using large query db
          const serverCache = await serverCacheDB.getCollection<T>(endpoint)
          totals.serverCache = serverCache.length
          await cacheDB.setBulkDocs(endpoint, serverCache)
          obs.next(serverCache)
        }
        // 3. get any newer docs from regular server db, merge with cache and emit
        const latest = await this._getCacheLastModified(endpoint)
        serverDB.streamCollection!(endpoint, {
          orderBy: '_modified',
          order: 'asc',
          where: {
            field: '_modified',
            operator: '>',
            value: latest,
          },
        }).subscribe(async updates => {
          totals.live = updates.length
          await cacheDB.setBulkDocs(endpoint, updates)
          const allDocs = await cacheDB.getCollection<T>(endpoint)
          console.group(`[${endpoint}] docs retrieved`)
          console.table(totals)
          console.groupEnd()
          obs.next(allDocs)
        })
      },
    )
    const subscription = observer.subscribe(value => onUpdate(value))
    return subscription
  }

  /**
   * Set multiple docs in a collection in batch.
   * NOTE - to set an individual doc a reference to that doc should be generated instead
   * i.e. `db.collection('users').doc('myUsername').set(data)`
   * @param docs - The collection of docs to set
   */
  async set(docs: any[]) {
    const { cacheDB, serverDB } = this.clients
    const dbDocs: DBDoc[] = docs.map(d =>
      new DocReference(this.endpoint, d._id, this.clients).batchDoc(d),
    )
    await serverDB.setBulkDocs(this.endpoint, dbDocs)
    await cacheDB.setBulkDocs(this.endpoint, dbDocs)
  }

  /**
   * Query a collection to retrieve all documents where a certain criteria is met,
   * such as the value of a slug field.
   * If no documents are found then an empty array is returned
   * @param field - The document key to run queries against, e.g. 'slug'
   * @param operator - query operator, '==', '>', '<'
   * @param value - The corresponding value to search for (only string or number supported)
   */
  async getWhere(
    field: string,
    operator: DBQueryWhereOperator,
    value: DBQueryWhereValue,
  ) {
    const { serverDB, cacheDB } = this.clients
    let docs = await serverDB.queryCollection<T>(this.endpoint, {
      where: { field, operator, value },
    })
    // if not found on live try find on cached (might be offline)
    // use catch as not all endpoints are cached or some might not be indexed
    if (docs.length === 0) {
      try {
        docs = await cacheDB.queryCollection<T>(this.endpoint, {
          where: { field, operator, value },
        })
      } catch (error) {
        console.error(error)
        // at least we can say we tried...
      }
    }
    return docs
  }

  private async _getCacheLastModified(endpoint: string) {
    const { cacheDB } = this.clients
    const latest = await cacheDB.queryCollection(endpoint, {
      orderBy: '_modified',
      order: 'desc',
      limit: 1,
    })
    return latest && latest.length > 0 ? latest[0]._modified : ''
  }
}

class DocReference<T> {
  public id: string
  constructor(
    private endpoint: string,
    docID: string = '_generate',
    private clients: DBClients,
  ) {
    this.id = docID === '_generate' ? this._generateDocID() : docID
  }

  /**
   * Get the target document data. Returns `undefined` if doc does not exist
   * @param source - Specify whether to fectch from cache or server.
   * By default will first check cache, and if doesn't exist will fetch from server
   * This is usually sufficient as the cache is updated when full collection sync'd
   */
  async get(
    source: 'server' | 'cache' = 'cache',
  ): Promise<(T & DBDoc) | undefined> {
    const { cacheDB, serverDB } = this.clients
    if (source === 'cache') {
      // 1. check cache, return if exists or skip to 2 if does not
      const cachedDoc = await cacheDB.getDoc<T>(this.endpoint, this.id)
      return cachedDoc ? cachedDoc : this.get('server')
    } else {
      // 2. get server docs and return
      // Note - do not cache after retrieval as could interfere with collection get
      // in case where doc retrieved before rest of collection get called
      const serverDoc = await serverDB.getDoc<T>(this.endpoint, this.id)
      return serverDoc
    }
  }

  /**
   * NOT CURRENTLY IN USE
   */
  async stream() {
    // TODO - if deemed useful by the platform
    throw new Error('stream method does not currently exist for docs')
    return
  }

  /**
   * Save data to the document. Will automatically populate with metadata including
   * `_created`, `_id`, `_modified` and `_deleted` fields
   * @param data - specified data in any format.
   * If contains metadata fields (e.g. `_id`)
   * then this will be used instead of generated id
   */
  async set(data: T) {
    const { serverDB, cacheDB } = this.clients
    const dbDoc: DBDoc = this._setDocMeta(data)
    await serverDB.setDoc(this.endpoint, dbDoc)
    await cacheDB.setDoc(this.endpoint, dbDoc)
  }

  /**
   * Documents are artificially deleted by replacing all contents with basic metadata and
   * `_deleted:true` property. This is so that other users can also sync the doc with their cache
   * TODO - schedule server permanent delete and find more elegant solution to notify users
   * to delete docs from their cache.
   */
  async delete() {
    return this.set({ _deleted: true } as any)
  }

  batchDoc(data: any) {
    return this._setDocMeta(data)
  }

  private _setDocMeta(data: any = {}): DBDoc {
    const d = data
    return {
      ...d,
      _created: d._created ? d._created : new Date().toISOString(),
      _deleted: d._deleted ? d._deleted : false,
      _id: this.id,
      _modified: new Date().toISOString(),
    }
  }

  private _generateDocID() {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let autoId = ''
    for (let i = 0; i < 20; i++) {
      autoId += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return autoId
  }
}
