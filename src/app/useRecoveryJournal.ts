import { useState } from 'react';
import { createRecoveryJournal } from '../utils/recoveryJournalCoordinator';
import { createRecoveryFunnel } from '../utils/recoveryFunnel';

export function useRecoveryJournal(announce: (message: string) => void) {
  const [recoveryJournal] = useState(() => createRecoveryJournal({
    failed: () => announce('Could not write recovery storage; keep your edits open.'),
  }));
  const [recoveryEvent] = useState(() => createRecoveryFunnel(recoveryJournal, error => {
    console.error('Could not capture recovery changes:', error);
    announce('Could not capture recovery changes; keep your edits open.');
  }));
  return { recoveryJournal, recoveryEvent };
}
