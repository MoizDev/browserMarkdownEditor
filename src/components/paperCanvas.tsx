import { Children, cloneElement, isValidElement, type ReactNode } from 'react';
import {
    ColorSchemeMenu, DefaultMainMenu, DefaultMainMenuContent, PreferencesGroup,
} from 'tldraw';
import type { TLUiMainMenuProps } from 'tldraw';

// Keep the library's menu and preferences intact except for the paper-only
// colour-scheme control. The component identities are its public menu API.
function withoutScheme(node: ReactNode): ReactNode {
    return Children.map(node, child => {
        if (!isValidElement<{ children?: ReactNode }>(child)) return child;
        if (child.type === ColorSchemeMenu) return null;
        if (child.type === PreferencesGroup) return <PaperPreferencesGroup />;
        if (child.props.children === undefined) return child;
        return cloneElement(child, {}, withoutScheme(child.props.children));
    });
}

function PaperPreferencesGroup() {
    return withoutScheme(PreferencesGroup());
}

function PaperMenuContent() {
    return withoutScheme(DefaultMainMenuContent());
}

export function PaperMainMenu(props: TLUiMainMenuProps) {
    return <DefaultMainMenu {...props}><PaperMenuContent /></DefaultMainMenu>;
}
