// Dropdown: a trigger button "Label: value" with a menu of options.
// Single choice closes on pick; multiple choice stays open and toggles, marks
// each row with a checkbox on the left and offers to clear the whole choice.
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, DownIcon } from './icons';
import { Popover } from './Popover';

export interface Option {
  value: string;
  label: string;
  // Shown as the row's tooltip, not in the row: the list stays narrow.
  hint?: string;
  // A quiet tag after the label (a profile's effort).
  tag?: string;
  dim?: boolean;
}

interface Common {
  label: ReactNode;
  options: Option[];
  testId?: string;
  empty?: string;
  disabled?: boolean;
  title?: string;
}

export function Dropdown(
  props: Common &
    ({ multiple?: false; value: string; onChange: (v: string) => void } | { multiple: true; value: string[]; onChange: (v: string[]) => void }),
) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const selected = (v: string) => (props.multiple ? props.value.includes(v) : props.value === v);

  const pick = (v: string) => {
    if (props.multiple) {
      const cur = props.value;
      props.onChange(cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
    } else {
      props.onChange(v);
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={'c-btn' + (open ? ' open' : '')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={props.testId}
        disabled={props.disabled}
        title={props.title}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="label">{props.label}</span>
        <DownIcon className="arrow" />
      </button>
      <Popover anchor={anchor} open={open} onClose={close} className="pick">
        {props.options.length === 0 && <div className="menu-note">{props.empty ?? 'Nothing to choose'}</div>}
        {props.multiple && props.value.length > 0 && (
          <button
            type="button"
            role="menuitem"
            className="row quiet clear"
            data-testid={props.testId ? props.testId + '-clear' : undefined}
            onClick={() => props.multiple && props.onChange([])}
          >
            <span className="t">Clear selection ({props.value.length})</span>
          </button>
        )}
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            role={props.multiple ? 'menuitemcheckbox' : 'menuitemradio'}
            aria-checked={selected(o.value)}
            className={'row' + (o.dim ? ' dim' : '')}
            title={o.hint}
            onClick={() => pick(o.value)}
          >
            <span className={'pk' + (props.multiple ? ' box' : '') + (selected(o.value) ? ' on' : '')}>{selected(o.value) && <CheckIcon />}</span>
            <span className="t">
              {o.label}
              {o.tag && <span className="tag">{o.tag}</span>}
            </span>
          </button>
        ))}
      </Popover>
    </>
  );
}
