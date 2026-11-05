// A new chat: the accent spark and a greeting in the
// serif, one line saying what the agent can see, the composer centred in the
// column (AgentPanel places it between these two pieces), and up to three
// suggestion chips under it drawn from what is open. A chip FILLS the composer
// and never sends: a suggestion that fired a run on one click would cost a
// reply nobody asked for.
//
// It replaced two paragraphs of policy text. The access sentence lives on the
// setup screen now, read once; the edit-and-undo sentence is the composer's
// caption, read every time at no cost.

import type { FocusedNote } from './useFocusedNote';
import { FileText, Pencil, Search, Spark } from './ui/icons';

function greeting(hour: number): string {
    return hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
}

export function Greeting({ vaultName, note }: { vaultName: string | null; note: FocusedNote }) {
    // Read per render: the screen is up for minutes at most, and a greeting
    // that ticked over at noon mid-sentence would be stranger than a stale one.
    const hello = greeting(new Date().getHours());
    let context: string;
    if (!vaultName) context = 'Open a vault to start';
    else context = `Working in ${vaultName}` + (note.name ? ` · ${note.name} is open` : '');
    return (
        <div className="agent-greet-block va-col">
            <h2 className="agent-greet">
                <Spark className="agent-greet-spark" aria-hidden="true" />
                <span>{hello}</span>
            </h2>
            <p className="agent-greet-sub">{context}</p>
        </div>
    );
}

/** `disabled` while the composer cannot take text (blocked, connecting): a
 *  chip then filled a disabled box and hid the reason its placeholder gave
 *  (measured: the text landed, the reason vanished). */
export function Suggestions({ note, disabled, onFill }: { note: FocusedNote; disabled: boolean; onFill: (text: string) => void }) {
    if (!note.name) return null;
    const chips = [
        { key: 'summarize', icon: <FileText />, label: `Summarize ${note.name}`, fill: `Summarize ${note.name} in a few lines.` },
        note.hasSelection && { key: 'tighten', icon: <Pencil />, label: 'Tighten this paragraph', fill: 'Tighten the paragraph I have selected.' },
        { key: 'related', icon: <Search />, label: 'Find related notes', fill: `Find notes related to ${note.name}.` },
    ].filter(c => !!c);
    return (
        <div className="agent-chips va-col">
            {chips.map(c => (
                <button key={c.key} type="button" className="agent-chip-suggest" disabled={disabled} onClick={() => onFill(c.fill)}>
                    {c.icon}
                    <span>{c.label}</span>
                </button>
            ))}
        </div>
    );
}
