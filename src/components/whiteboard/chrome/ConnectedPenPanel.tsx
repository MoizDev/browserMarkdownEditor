import { useSyncExternalStore } from 'react';
import { PenPanel, type PenPanelProps } from './PenPanel';
import { getPenPanelCollapsed, setPenPanelCollapsed, subscribePenPanel } from './penPanelStore';

export type ConnectedPenPanelProps = Omit<PenPanelProps, 'collapsed' | 'setCollapsed'>;

export function ConnectedPenPanel(props: ConnectedPenPanelProps) {
    const collapsed = useSyncExternalStore(subscribePenPanel, getPenPanelCollapsed, getPenPanelCollapsed);
    return <PenPanel {...props} collapsed={collapsed} setCollapsed={setPenPanelCollapsed} />;
}
