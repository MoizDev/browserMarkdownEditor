import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { setTableNotify } from '../editor/tableEdit';

export interface DialogRequest {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  input?: {
    label: string;
    initialValue: string;
    placeholder?: string;
    validate?: (value: string) => string | null;
  };
}
export interface AppDialog extends DialogRequest {
  onConfirm: (value: string) => void;
  onCancel?: () => void;
  altLabel?: string;
  onAlt?: () => void;
  id?: number;
}

export function useAppDialogs() {
  const [dialog, setDialog] = useState<AppDialog | null>(null);

  const dialogRef = useRef<AppDialog | null>(null);
  const dialogSeq = useRef(0);

  const raise = useCallback((next: AppDialog) => {
    // Settled FIRST, so that its own `setDialog(null)` cannot land on top of the
    // dialog installed below — both writes batch, and the last one must win.
    const prev = dialogRef.current;
    if (prev) (prev.onCancel ?? (() => prev.onConfirm('')))();
    const staged = { ...next, id: ++dialogSeq.current };
    dialogRef.current = staged;
    setDialog(staged);
  }, []);

  const settle = useCallback(() => { dialogRef.current = null; setDialog(null); }, []);

  const ask = useCallback((question: DialogRequest) => new Promise<boolean>(resolve => {
    raise({
      ...question,
      onConfirm: () => { settle(); resolve(true); },
      onCancel: () => { settle(); resolve(false); },
    });
  }), [raise, settle]);

  const askChoice = useCallback((question: DialogRequest & { altLabel: string }) =>
    new Promise<'confirm' | 'alt' | 'cancel'>(resolve => {
      raise({
        ...question,
        onConfirm: () => { settle(); resolve('confirm'); },
        onAlt: () => { settle(); resolve('alt'); },
        onCancel: () => { settle(); resolve('cancel'); },
      });
    }), [raise, settle]);

  const tell = useCallback((notice: DialogRequest) => new Promise<void>(resolve => {
    raise({ ...notice, onConfirm: () => { settle(); resolve(); } });
  }), [raise, settle]);

  const askForName = useCallback((question: DialogRequest & { input: NonNullable<AppDialog['input']> }) =>
    new Promise<string | null>(resolve => {
      raise({
        ...question,
        onConfirm: (value: string) => { settle(); resolve(value.trim()); },
        onCancel: () => { settle(); resolve(null); },
      });
    }), [raise, settle]);

  const notify = useCallback((message: string) => {
    if (typeof message !== 'string' || !message.trim()) {
      console.error('An app notice needs a nonempty message:', new Error('Invalid app notice').stack);
    }
    void tell({ title: 'Could not continue', confirmLabel: 'OK', body: message });
  }, [tell]);

  useEffect(() => { setTableNotify(notify); }, [notify]);

  const notifyRef = useRef(notify);
  useEffect(() => { notifyRef.current = notify; }, [notify]);
  const tellRef = useRef(tell);
  useEffect(() => { tellRef.current = tell; }, [tell]);

  return { dialog, dialogRef, ask, askChoice, tell, askForName, notify, notifyRef, tellRef };
}

export type AppDialogs = ReturnType<typeof useAppDialogs>;
export type Ask = AppDialogs['ask'];
export type Tell = AppDialogs['tell'];
export type Notify = AppDialogs['notify'];
