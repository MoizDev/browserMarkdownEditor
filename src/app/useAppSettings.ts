import { useCallback, useEffect, useState } from 'react';
import { clampTabSize } from '../editor/lists';
import { clampRecentVaultLimit, DEFAULT_RECENT_VAULT_LIMIT } from '../utils/recentVaults';
import { writeStoredValue } from '../utils/storage';
import type { CaretStyle, FileSystemContextValue, SettingsDefaults, Theme } from '../types';
import { APP_TITLE } from '../utils/appTitle';

/** localStorage is the user's to edit, and a NaN here would reach a CSS
 *  variable and then CodeMirror's own measuring. 10–24px, 14 by default. */
function clampCodeFontSize(value: number): number {
    return Number.isFinite(value) ? Math.min(24, Math.max(10, Math.round(value))) : 14;
}

/** What the settings hook reads from App. */
export interface UseAppSettingsDeps {
  rootHandle: FileSystemContextValue['rootHandle'];
}

export function useAppSettings(deps: UseAppSettingsDeps) {
  const { rootHandle } = deps;

  // The global light/dark theme state
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') as Theme) || 'dark');

  // Font size and padding settings (persisted via localStorage)
  const [editorFontSize, setEditorFontSize] = useState<number>(() => parseInt(localStorage.getItem('editorFontSize') || '16', 10));
  // Code panes only (editor/codeHighlight.ts reads the variable). Separate from
  // the note size because Fira Code at a note's 16px reads larger than the prose
  // does, and because the two are chosen for different jobs.
  const [codeFontSize, setCodeFontSize] = useState<number>(() => clampCodeFontSize(parseInt(localStorage.getItem('codeFontSize') || '', 10)));
  // Depth-coloured brackets in code panes. On by default: in a Lisp they are
  // how the code is read (editor/rainbowBrackets.ts).
  const [rainbowBrackets, setRainbowBrackets] = useState<boolean>(() => localStorage.getItem('rainbowBrackets') !== 'false');
  const [treeFontSize, setTreeFontSize] = useState<number>(() => parseInt(localStorage.getItem('treeFontSize') || '13', 10));
  // Clamped to the slider's range on the way in: localStorage is user-editable,
  // and a `NaN%` voids index.css's `max(var(--editor-padding), …)` outright —
  // the editor's left padding drops to 0 and the collapse arrow is clipped.
  const [editorPadding, setEditorPadding] = useState<number>(() => {
    const stored = parseInt(localStorage.getItem('editorPadding') || '6', 10);
    return Number.isFinite(stored) ? Math.min(20, Math.max(0, stored)) : 6;
  });
  // Spaces a Tab inserts — and how far Tab indents a list item. Clamped on the
  // way in: localStorage is user-editable and a NaN would reach CodeMirror.
  const [tabSize, setTabSize] = useState<number>(() => clampTabSize(parseInt(localStorage.getItem('tabSize') || '4', 10)));

  // How many recently opened vaults the vault switcher's menu lists. Clamped for
  // the same reason as tabSize — this one ends up in Array.slice.
  const [recentVaultLimit, setRecentVaultLimit] = useState<number>(
    () => clampRecentVaultLimit(parseInt(localStorage.getItem('recentVaultLimit') || String(DEFAULT_RECENT_VAULT_LIMIT), 10))
  );

  // Whether the browser tab is titled with the open vault's name (default on).
  const [showVaultInTitle, setShowVaultInTitle] = useState<boolean>(() => (localStorage.getItem('showVaultInTitle') ?? 'true') === 'true');

  // Caret (text cursor) appearance settings — persisted via localStorage.
  // caretStyle: 'line' (thin bar) or 'block' (thick terminal-style block).
  // smoothCaret: glide the caret between positions like MS Word.
  // caretSpeed: duration (ms) of that glide.
  const [caretStyle, setCaretStyle] = useState<CaretStyle>(() => (localStorage.getItem('caretStyle') as CaretStyle) || 'line');
  const [caretThickness, setCaretThickness] = useState<number>(() => parseInt(localStorage.getItem('caretThickness') || '10', 10));
  const [smoothCaret, setSmoothCaret] = useState<boolean>(() => (localStorage.getItem('smoothCaret') ?? 'true') === 'true');
  const [caretSpeed, setCaretSpeed] = useState<number>(() => parseInt(localStorage.getItem('caretSpeed') || '80', 10));

  // Custom font loaded from Google Fonts (empty string = use the default)
  const [fontFamily, setFontFamily] = useState<string>(() => localStorage.getItem('fontFamily') || '');

  // Custom accent color (empty string = each theme's default purple)
  const [accentColor, setAccentColor] = useState<string>(() => localStorage.getItem('accentColor') || '');

  // Base ink for language-less ``` blocks (empty string = follow the accent)
  const [codeBlockColor, setCodeBlockColor] = useState<string>(() => localStorage.getItem('codeBlockColor') || '');

  // Keep HTML root data attribute in sync with state for global CSS variables
  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    writeStoredValue('theme', theme);
  }, [theme]);

  // Sync font sizes to CSS variables and localStorage
  useEffect(() => {
    document.documentElement.style.setProperty('--font-size-normal', editorFontSize + 'px');
    writeStoredValue('editorFontSize', String(editorFontSize));
  }, [editorFontSize]);

  useEffect(() => {
    document.documentElement.style.setProperty('--code-font-size', codeFontSize + 'px');
    writeStoredValue('codeFontSize', String(codeFontSize));
  }, [codeFontSize]);

  // Not a CSS variable: the plugin is an editor extension, so each code pane
  // reconfigures its own compartment (DocumentPane).
  useEffect(() => {
    writeStoredValue('rainbowBrackets', String(rainbowBrackets));
  }, [rainbowBrackets]);

  useEffect(() => {
    document.documentElement.style.setProperty('--nav-item-size', treeFontSize + 'px');
    writeStoredValue('treeFontSize', String(treeFontSize));
  }, [treeFontSize]);

  useEffect(() => {
    document.documentElement.style.setProperty('--editor-padding', editorPadding + '%');
    writeStoredValue('editorPadding', String(editorPadding));
  }, [editorPadding]);

  useEffect(() => {
    writeStoredValue('tabSize', String(tabSize));
  }, [tabSize]);

  useEffect(() => {
    writeStoredValue('recentVaultLimit', String(recentVaultLimit));
  }, [recentVaultLimit]);

  useEffect(() => {
    writeStoredValue('showVaultInTitle', String(showVaultInTitle));
  }, [showVaultInTitle]);

  // The tab reads as the vault it holds, so tabs open on different vaults can
  // be told apart. `rootHandle.name` is the folder name the file tree's header
  // shows; an OPFS root's is '' and falls back rather than blanking the tab.
  useEffect(() => {
    document.title = showVaultInTitle && rootHandle?.name ? rootHandle.name : APP_TITLE;
  }, [rootHandle, showVaultInTitle]);

  // Translate the caret settings into CSS variables the CodeMirror theme reads.
  useEffect(() => {
    const root = document.documentElement.style;
    const isBlock = caretStyle === 'block';

    // A block caret fills ~0.6 character widths with a semi-transparent overlay
    // so the glyph beneath stays readable; a line caret uses the thickness slider.
    // Both caret styles use a translucent accent (the line caret's equivalent
    // lives in cmTheme), so they follow a custom accent in either app theme.
    root.setProperty('--caret-line-width', isBlock ? '0px' : caretThickness + 'px');
    root.setProperty('--caret-block-width', isBlock ? '0.6em' : '0px');
    root.setProperty('--caret-block-bg', isBlock
      ? 'color-mix(in srgb, var(--interactive-accent) 40%, transparent)'
      : 'transparent');
    root.setProperty('--caret-radius', isBlock ? '1px' : '0');

    // The smooth glide that gives it the MS Word feel — animate position & height.
    root.setProperty('--caret-transition', smoothCaret
      ? `left ${caretSpeed}ms ease-out, top ${caretSpeed}ms ease-out, height ${caretSpeed}ms ease-out`
      : 'none');

    writeStoredValue('caretStyle', caretStyle);
    writeStoredValue('caretThickness', String(caretThickness));
    writeStoredValue('smoothCaret', String(smoothCaret));
    writeStoredValue('caretSpeed', String(caretSpeed));
  }, [caretStyle, caretThickness, smoothCaret, caretSpeed]);

  // Load a Google Font by name and apply it app-wide via --font-text.
  useEffect(() => {
    writeStoredValue('fontFamily', fontFamily);
    const linkId = 'google-font-link';
    let link = document.getElementById(linkId) as HTMLLinkElement | null;
    const family = fontFamily.trim();
    const fallback = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, "Roboto", sans-serif';

    if (family) {
      const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap`;
      if (!link) {
        link = document.createElement('link');
        link.id = linkId;
        link.rel = 'stylesheet';
        document.head.appendChild(link);
      }
      link.href = href;
      document.documentElement.style.setProperty('--font-text', `"${family}", ${fallback}`);
    } else {
      if (link) link.remove();
      document.documentElement.style.removeProperty('--font-text');
    }
  }, [fontFamily]);

  // One custom accent recolors links, code, buttons and highlights everywhere:
  // an inline override on <html> outranks both theme blocks, so it holds across
  // dark/light switches. The hover shade is derived rather than picked —
  // color-mix is fine here, the app is Chromium-only anyway (File System API).
  useEffect(() => {
    const root = document.documentElement.style;
    if (accentColor) {
      root.setProperty('--text-accent', accentColor);
      root.setProperty('--interactive-accent', accentColor);
      root.setProperty('--interactive-accent-hover', `color-mix(in srgb, ${accentColor} 85%, black)`);
    } else {
      root.removeProperty('--text-accent');
      root.removeProperty('--interactive-accent');
      root.removeProperty('--interactive-accent-hover');
    }
    writeStoredValue('accentColor', accentColor);
  }, [accentColor]);

  // Same override trick for the plain-code-block ink; its stylesheet default
  // is var(--text-accent), so with no custom pick it tracks the accent.
  useEffect(() => {
    const root = document.documentElement.style;
    if (codeBlockColor) {
      root.setProperty('--code-block-color', codeBlockColor);
    } else {
      root.removeProperty('--code-block-color');
    }
    writeStoredValue('codeBlockColor', codeBlockColor);
  }, [codeBlockColor]);

  const handleResetDefaults = useCallback((defaults: SettingsDefaults) => {
    setEditorFontSize(defaults.editorFontSize);
    setCodeFontSize(defaults.codeFontSize);
    setRainbowBrackets(defaults.rainbowBrackets);
    setTreeFontSize(defaults.treeFontSize);
    setEditorPadding(defaults.editorPadding);
    setTabSize(defaults.tabSize);
    setCaretStyle(defaults.caretStyle);
    setCaretThickness(defaults.caretThickness);
    setSmoothCaret(defaults.smoothCaret);
    setCaretSpeed(defaults.caretSpeed);
    setFontFamily('');
    setAccentColor(defaults.accentColor);
    setCodeBlockColor(defaults.codeBlockColor);
    setRecentVaultLimit(defaults.recentVaultLimit);
    setShowVaultInTitle(defaults.showVaultInTitle);
  }, []);
  const toggleTheme = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), []);

  return {
    theme, toggleTheme,
    editorFontSize, setEditorFontSize,
    codeFontSize, setCodeFontSize,
    rainbowBrackets, setRainbowBrackets,
    treeFontSize, setTreeFontSize,
    editorPadding, setEditorPadding,
    tabSize, setTabSize,
    recentVaultLimit, setRecentVaultLimit,
    showVaultInTitle, setShowVaultInTitle,
    caretStyle, setCaretStyle,
    caretThickness, setCaretThickness,
    smoothCaret, setSmoothCaret,
    caretSpeed, setCaretSpeed,
    fontFamily, setFontFamily,
    accentColor, setAccentColor,
    codeBlockColor, setCodeBlockColor,
    handleResetDefaults,
  };
}
