import { useCallback, useEffect, useState } from 'react';
import { clampTabSize } from '../editor/lists';
import { clampRecentVaultLimit, DEFAULT_RECENT_VAULT_LIMIT } from '../utils/recentVaults';
import { readStoredValue, writeStoredValue } from '../utils/storage';
import type { CaretStyle, FileSystemContextValue, SettingsDefaults, Theme } from '../types';
import { APP_TITLE } from '../utils/appTitle';

function clampCodeFontSize(value: number): number {
    return Number.isFinite(value) ? Math.min(24, Math.max(10, Math.round(value))) : 14;
}

export interface UseAppSettingsDeps {
  rootHandle: FileSystemContextValue['rootHandle'];
}

export function useAppSettings(deps: UseAppSettingsDeps) {
  const { rootHandle } = deps;

  const [theme, setTheme] = useState<Theme>(() => (readStoredValue('theme') as Theme) || 'dark');

  const [editorFontSize, setEditorFontSize] = useState<number>(() => parseInt(readStoredValue('editorFontSize') || '16', 10));
  const [codeFontSize, setCodeFontSize] = useState<number>(() => clampCodeFontSize(parseInt(readStoredValue('codeFontSize') || '', 10)));
  const [rainbowBrackets, setRainbowBrackets] = useState<boolean>(() => readStoredValue('rainbowBrackets') !== 'false');
  const [treeFontSize, setTreeFontSize] = useState<number>(() => parseInt(readStoredValue('treeFontSize') || '13', 10));
  const [editorPadding, setEditorPadding] = useState<number>(() => {
    const stored = parseInt(readStoredValue('editorPadding') || '6', 10);
    return Number.isFinite(stored) ? Math.min(20, Math.max(0, stored)) : 6;
  });
  const [tabSize, setTabSize] = useState<number>(() => clampTabSize(parseInt(readStoredValue('tabSize') || '4', 10)));

  const [recentVaultLimit, setRecentVaultLimit] = useState<number>(
    () => clampRecentVaultLimit(parseInt(readStoredValue('recentVaultLimit') || String(DEFAULT_RECENT_VAULT_LIMIT), 10))
  );

  const [showVaultInTitle, setShowVaultInTitle] = useState<boolean>(() => (readStoredValue('showVaultInTitle') ?? 'true') === 'true');

  const [caretStyle, setCaretStyle] = useState<CaretStyle>(() => (readStoredValue('caretStyle') as CaretStyle) || 'line');
  const [caretThickness, setCaretThickness] = useState<number>(() => parseInt(readStoredValue('caretThickness') || '10', 10));
  const [smoothCaret, setSmoothCaret] = useState<boolean>(() => (readStoredValue('smoothCaret') ?? 'true') === 'true');
  const [caretSpeed, setCaretSpeed] = useState<number>(() => parseInt(readStoredValue('caretSpeed') || '80', 10));

  const [fontFamily, setFontFamily] = useState<string>(() => readStoredValue('fontFamily') || '');

  const [accentColor, setAccentColor] = useState<string>(() => readStoredValue('accentColor') || '');

  const [codeBlockColor, setCodeBlockColor] = useState<string>(() => readStoredValue('codeBlockColor') || '');

  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    writeStoredValue('theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--font-size-normal', editorFontSize + 'px');
    writeStoredValue('editorFontSize', String(editorFontSize));
  }, [editorFontSize]);

  useEffect(() => {
    document.documentElement.style.setProperty('--code-font-size', codeFontSize + 'px');
    writeStoredValue('codeFontSize', String(codeFontSize));
  }, [codeFontSize]);

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

  useEffect(() => {
    document.title = showVaultInTitle && rootHandle?.name ? rootHandle.name : APP_TITLE;
  }, [rootHandle, showVaultInTitle]);

  useEffect(() => {
    const root = document.documentElement.style;
    const isBlock = caretStyle === 'block';

    root.setProperty('--caret-line-width', isBlock ? '0px' : caretThickness + 'px');
    root.setProperty('--caret-block-width', isBlock ? '0.6em' : '0px');
    root.setProperty('--caret-block-bg', isBlock
      ? 'color-mix(in srgb, var(--interactive-accent) 40%, transparent)'
      : 'transparent');
    root.setProperty('--caret-radius', isBlock ? '1px' : '0');

    root.setProperty('--caret-transition', smoothCaret
      ? `left ${caretSpeed}ms ease-out, top ${caretSpeed}ms ease-out, height ${caretSpeed}ms ease-out`
      : 'none');

    writeStoredValue('caretStyle', caretStyle);
    writeStoredValue('caretThickness', String(caretThickness));
    writeStoredValue('smoothCaret', String(smoothCaret));
    writeStoredValue('caretSpeed', String(caretSpeed));
  }, [caretStyle, caretThickness, smoothCaret, caretSpeed]);

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
