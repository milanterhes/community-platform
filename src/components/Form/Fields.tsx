import * as React from 'react'
import { TextAreaStyled, Input, TextAreaDisabled } from './elements'
import { FieldRenderProps } from 'react-final-form'

// any props can be passed to field and down to child component
// input and meta props come from react field render props and will be
// picked up by typing
type FieldProps = FieldRenderProps & { children?: React.ReactNode }
export interface IFieldProps extends FieldProps {
  // additional fields intending to pass down
  disabled?: boolean
  children?: React.ReactNode
}

export const InputField = ({ input, meta, ...rest }: IFieldProps) => (
  <>
    <Input {...input} {...rest} />
    {meta.error && meta.touched && <span>{meta.error}</span>}
  </>
)

export const TextAreaField = ({
  input,
  meta,
  disabled,
  ...rest
}: IFieldProps) => (
  <>
    {disabled ? (
      // want disabled textarea to just render as styled div to remove scrollbars
      <TextAreaDisabled>{input.value}</TextAreaDisabled>
    ) : (
      <TextAreaStyled {...input} {...rest} />
    )}

    {/* {meta.error && meta.touched && <span>{meta.error}</span>} */}
  </>
)
