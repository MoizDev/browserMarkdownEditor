export const NO_SENSITIVE_IDS: ReadonlySet<string> = Object.freeze(new Set<string>());

export interface SensitiveTargets {
    ids(): ReadonlySet<string>;
    setHovered(id: string | null): void;
    setEditing(id: string | null): void;
}

export function createSensitiveTargets(onChange: () => void): SensitiveTargets {
    let hovered: string | null = null, editing: string | null = null, current = NO_SENSITIVE_IDS;
    const publish = () => {
        const members = new Set<string>();
        if (hovered !== null) members.add(hovered);
        if (editing !== null) members.add(editing);
        if (members.size === current.size && [...members].every(id => current.has(id))) return;
        current = members.size ? Object.freeze(members) : NO_SENSITIVE_IDS;
        onChange();
    };
    return {
        ids: () => current,
        setHovered(id) { if (hovered !== id) { hovered = id; publish(); } },
        setEditing(id) { if (editing !== id) { editing = id; publish(); } },
    };
}
