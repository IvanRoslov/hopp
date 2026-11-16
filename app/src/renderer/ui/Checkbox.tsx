import { CheckIcon } from './icons';

// Checkbox: a 14 px box drawn with the control border, no browser control.
export function Checkbox(props: { checked: boolean; onChange?: (v: boolean) => void; label: string; readOnly?: boolean }) {
  const box = <span className={'cb-box' + (props.checked ? ' on' : '')} aria-hidden>{props.checked && <CheckIcon width={11} height={11} />}</span>;
  if (props.readOnly) {
    return (
      <span className="cb readonly" role="checkbox" aria-checked={props.checked} aria-readonly aria-label={props.label}>
        {box}
        <span>{props.label}</span>
      </span>
    );
  }
  return (
    <button type="button" className="cb" role="checkbox" aria-checked={props.checked} onClick={() => props.onChange?.(!props.checked)}>
      {box}
      <span>{props.label}</span>
    </button>
  );
}
