import React from 'react';
import { FileText } from './icons';
import { baseName } from '../utils/graph';
import type { CSSProperties } from 'react';
import type { GraphNode, OpenNodeHandler } from '../types';

interface BacklinksPanelProps {
    nodes?: GraphNode[];
    onOpenNode: OpenNodeHandler;
    onClose: () => void;
    style?: CSSProperties;
}

export default function BacklinksPanel({ nodes = [], onOpenNode, onClose, style }: BacklinksPanelProps) {
    return (
        <div className="backlinks-popover" style={style} role="dialog" aria-label="Linked mentions">
            <div className="backlinks-popover-header">
                <span className="backlinks-title">Linked mentions</span>
                <span className="backlinks-count">{nodes.length}</span>
                <button
                    className="backlinks-popover-close"
                    onClick={onClose}
                    data-tooltip="Close"
                    aria-label="Close linked mentions"
                >
                    ×
                </button>
            </div>
            <div className="backlinks-body">
                {nodes.length === 0 ? (
                    <p className="backlinks-empty">No backlinks to this note yet.</p>
                ) : (
                    nodes.map(n => (
                        <button
                            key={n.id}
                            className="backlink-item"
                            onClick={() => { if (!n.unresolved) { onOpenNode(n); onClose(); } }}
                            data-tooltip={n.label}
                        >
                            <FileText size={13} />
                            <span className="backlink-name">{baseName(n.name)}</span>
                        </button>
                    ))
                )}
            </div>
        </div>
    );
}
