import type { DeletionScope } from '../api/types'

export function RecurringDeleteChoices({ busy, onChoose, onCancel }: {
  busy: boolean
  onChoose: (scope: DeletionScope) => void
  onCancel: () => void
}) {
  return (
    <div className="recurring-delete" role="group" aria-label="Delete repeating event">
      <p>Delete which events?</p>
      <button className="btn btn--danger" disabled={busy} autoFocus onClick={() => onChoose('this')}>This event only</button>
      <button className="btn btn--danger" disabled={busy} onClick={() => onChoose('future')}>This and all future events</button>
      <button className="btn btn--danger" disabled={busy} onClick={() => onChoose('all')}>All events in this series</button>
      <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  )
}
