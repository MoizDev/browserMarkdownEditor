const stack: Array<() => void> = [];

function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    const top = stack[stack.length - 1];
    if (!top) return;
    e.preventDefault();
    top();
}

export function dismissOnEscape(onDismiss: () => void): () => void {
    const entry = () => onDismiss();
    stack.push(entry);
    if (stack.length === 1) document.addEventListener('keydown', onKeyDown);
    return () => {
        const i = stack.lastIndexOf(entry);
        if (i < 0) return;
        stack.splice(i, 1);
        if (stack.length === 0) document.removeEventListener('keydown', onKeyDown);
    };
}
