export function Switch(props: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled}
      className={'switch' + (props.on ? ' on' : '')}
      onClick={() => props.onChange(!props.on)}
    />
  );
}
