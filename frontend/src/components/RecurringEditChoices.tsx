import type { DeletionScope } from '../api/types'

export function RecurringEditChoices({ busy, onChoose, onCancel }: {
  busy: boolean; onChoose: (scope: DeletionScope) => void; onCancel: () => void
}) {
  return <div className="recurring-delete" role="group" aria-label="Edit repeating event">
    <p>Apply changes to which events?</p>
    <button className="btn btn--primary" disabled={busy} onClick={() => onChoose('this')}>This event only</button>
    <button className="btn btn--primary" disabled={busy} onClick={() => onChoose('future')}>This and all future events</button>
    <button className="btn btn--primary" disabled={busy} onClick={() => onChoose('all')}>All events in this series</button>
    <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
  </div>
}
