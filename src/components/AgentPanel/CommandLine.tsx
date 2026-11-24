// A terminal command the user is told to run, with a Copy button — the setup
// guide's login and install lines, and the agent warnings'.

import { useEffect, useRef, useState } from 'react';
import { copyText } from '../../utils/clipboard';
import { Check } from '../icons';

export function CommandLine({ command }: { command: string }) {
    const [copied, setCopied] = useState(false);
    const timer = useRef(0);
    useEffect(() => () => clearTimeout(timer.current), []);
    const copy = async () => {
        if (!(await copyText(command))) return;
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
    };
    return (
        <span className="agent-command">
            <code>{command}</code>
            <button
                type="button"
                className="agent-command-copy"
                onClick={copy}
                aria-label={copied ? 'Copied' : `Copy ${command}`}
                data-tooltip={copied ? 'Copied' : 'Copy'}
            >
                {copied ? <Check size={13} /> : (
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" /></svg>
                )}
            </button>
        </span>
    );
}
