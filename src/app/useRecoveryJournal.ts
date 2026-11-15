import { useState } from 'react';
import { createRecoveryJournal } from '../utils/recoveryJournalCoordinator';
import { createRecoveryFunnel } from '../utils/recoveryFunnel';

/** The crash-recovery journal and the one funnel every document change reports into. */
export function useRecoveryJournal(announce: (message: string) => void) {
  const [recoveryJournal] = useState(() => createRecoveryJournal({
    refused: () => announce('Recovery storage may be evicted by the browser.'),
    failed: () => announce('Could not write recovery storage; keep your edits open.'),
  }));
  const [recoveryEvent] = useState(() => createRecoveryFunnel(recoveryJournal, error => {
    console.error('Could not capture recovery changes:', error);
    announce('Could not capture recovery changes; keep your edits open.');
  }));
  return { recoveryJournal, recoveryEvent };
}
