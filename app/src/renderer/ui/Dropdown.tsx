// Dropdown: a trigger button "Label: value" with a menu of options.
// Single choice closes on pick; multiple choice stays open and toggles.
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, DownIcon } from './icons';
import { Popover } from './Popover';

export interface Option {
  value: string;
  label: string;
  hint?: string;
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
      <Popover anchor={anchor} open={open} onClose={close}>
        {props.options.length === 0 && <div className="menu-note">{props.empty ?? 'Nothing to choose'}</div>}
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            role={props.multiple ? 'menuitemcheckbox' : 'menuitemradio'}
            aria-checked={selected(o.value)}
            className={'row' + (o.dim ? ' dim' : '')}
            onClick={() => pick(o.value)}
          >
            <span className="t">
              {o.label}
              {o.hint && <span className="muted"> · {o.hint}</span>}
            </span>
            <span className="ck">{selected(o.value) && <CheckIcon />}</span>
          </button>
        ))}
      </Popover>
    </>
  );
}
