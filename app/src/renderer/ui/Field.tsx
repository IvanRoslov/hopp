import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';

// Field: a label, an input (or textarea), and under it either the error for
// this field or a hint.
export function Field(
  props: {
    label: ReactNode;
    error?: string;
    hint?: ReactNode;
    multiline?: boolean;
    after?: ReactNode;
  } & (InputHTMLAttributes<HTMLInputElement> & TextareaHTMLAttributes<HTMLTextAreaElement>),
) {
  const { label, error, hint, multiline, after, ...rest } = props;
  const id = useId();
  const describe = error || hint ? id + '-d' : undefined;
  const control = multiline ? (
    <textarea id={id} aria-invalid={!!error} aria-describedby={describe} {...rest} />
  ) : (
    <input id={id} aria-invalid={!!error} aria-describedby={describe} {...rest} />
  );
  return (
    <div className={'field' + (error ? ' has-error' : '')}>
      <label className="fl" htmlFor={id}>
        {label}
      </label>
      {after ? (
        <div className="with-btn">
          {control}
          {after}
        </div>
      ) : (
        control
      )}
      {error ? (
        <small id={describe} className="error" role="alert">
          {error}
        </small>
      ) : hint ? (
        <small id={describe}>{hint}</small>
      ) : null}
    </div>
  );
}
