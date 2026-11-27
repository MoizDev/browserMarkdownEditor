import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { penScaleFromSlider } from '../../../whiteboard/chrome/penWidth';
import { MIXED, type Shared, type StyleRow } from '../../../whiteboard/chrome/stylePanel';
import type { StyleCommands, StylePanelSnapshot } from '../../../whiteboard/host/styleControls';
import { ARROWHEADS, FIGURE_SHAPES, FILLS, DASHES, FONTS, OPACITIES, SIZES, V_ALIGNS, type Arrowhead, type Dash, type Fill,
    type FigureShape, type Font, type HAlign, type Size, type Swatch, type TextAlign, type VAlign } from '../../../whiteboard/model/styles';
import { dismissOnEscape } from '../../../utils/escapeDismiss';
import type { ToolLabel } from './toolChoices';
import { ToolIcon } from './toolIcons';
import { StyleGlyph } from './styleIcons';
import { getStylePanelCollapsed, registerStylePanelFocus, setStylePanelCollapsed, subscribeStylePanel } from './stylePanelStore';
import './chrome.css';

export interface StylePanelProps {
    readonly snapshot: StylePanelSnapshot;
    readonly commands: StyleCommands;
    readonly toolLabel: (key: ToolLabel) => string;
    readonly subheadings: boolean;
    readonly history: (id: 'undo' | 'redo') => void;
}

const WIDTH_UNDO = 'Change pen width';
const KEY_STEP: Readonly<Record<string, number>> = { ArrowLeft: -0.02, ArrowDown: -0.02, ArrowRight: 0.02, ArrowUp: 0.02, PageDown: -0.1, PageUp: 0.1 };
const NO_STYLE_TOOLS = new Set(['hand', 'zoom', 'eraser', 'laser']);
const FONT_FAMILY: Readonly<Record<Font, string>> = { draw: '"WB Draw", system-ui', sans: 'system-ui, sans-serif', serif: 'Georgia, serif', mono: 'ui-monospace, monospace' };
const HEAD_KEYS: Readonly<Record<Arrowhead, string>> = { none: 'styles.none', arrow: 'styles.headArrow', triangle: 'styles.headTriangle',
    square: 'styles.headSquare', dot: 'styles.headDot', pipe: 'styles.headPipe', diamond: 'styles.headDiamond', inverted: 'styles.headInverted', bar: 'styles.headBar' };
const FILL_KEYS: Readonly<Record<Fill, string>> = { none: 'styles.none', semi: 'styles.semi', solid: 'styles.solid', fill: 'styles.fillSolid',
    pattern: 'styles.pattern', 'lined-fill': 'styles.linedFill' };
const DASH_KEYS: Readonly<Record<Exclude<Dash, 'none'>, string>> = { draw: 'styles.draw', solid: 'styles.solid', dashed: 'styles.dashed', dotted: 'styles.dotted' };
const SIZE_KEYS: Readonly<Record<Size, string>> = { s: 'styles.small', m: 'styles.medium', l: 'styles.large', xl: 'styles.extraLarge' };
const ALIGN_KEYS: Readonly<Record<TextAlign, string>> = { start: 'styles.start', middle: 'styles.middle', end: 'styles.end' };
const VALIGN_KEYS: Readonly<Record<VAlign, string>> = { start: 'styles.top', middle: 'styles.middle', end: 'styles.bottom' };

function panelHistoryKey(event: KeyboardEvent<HTMLElement>, history: StylePanelProps['history']): boolean {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z') return false;
    event.preventDefault(); event.stopPropagation();
    history(event.shiftKey ? 'redo' : 'undo');
    return true;
}

function returnToBoard(from: Element): void {
    from.closest('.board-viewer-host')?.querySelector<HTMLElement>('.board-interaction-root')?.focus({ preventScroll: true });
}

function sameShared<T>(shared: Shared<T>, value: T): boolean { return shared !== MIXED && shared !== null && shared === value; }

interface Choice<T> {
    readonly value: T;
    readonly label: string;
    readonly icon: ReactNode;
    readonly style?: CSSProperties;
    readonly className?: string;
}

interface ChoiceGroupProps<T> {
    readonly label: string;
    readonly choices: readonly Choice<T>[];
    readonly selected: Shared<T>;
    readonly columns: number;
    readonly disabled: boolean;
    readonly undo: string;
    readonly commands: StyleCommands;
    readonly onPick: (value: T) => void;
    readonly onSettled?: () => void;
}

function ChoiceGroup<T extends string | number>({ label, choices, selected, columns, disabled, undo, commands, onPick, onSettled }: ChoiceGroupProps<T>) {
    const scrubbing = useRef(false), group = useRef<HTMLDivElement>(null);
    const pick = useRef(onPick), settled = useRef(onSettled);
    useEffect(() => { pick.current = onPick; settled.current = onSettled; });
    useEffect(() => {
        const release = () => {
            if (!scrubbing.current) return;
            scrubbing.current = false;
            commands.endGesture();
            if (group.current) returnToBoard(group.current);
            settled.current?.();
        };
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', release);
        return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); release(); };
    }, [commands]);
    const down = (event: PointerEvent<HTMLButtonElement>, value: T) => {
        if (event.button !== 0 || disabled) return;
        scrubbing.current = true;
        commands.beginGesture(undo);
        pick.current(value);
    };
    return <div ref={group} className="board-style-choices" role="group" aria-label={label}
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {choices.map(choice => <button key={String(choice.value)} type="button"
            className={`board-style-choice${choice.className ? ` ${choice.className}` : ''}`}
            aria-label={choice.label} data-tooltip={choice.label} aria-pressed={sameShared(selected, choice.value)}
            disabled={disabled} style={choice.style}
            onPointerDown={event => down(event, choice.value)}
            onPointerEnter={event => { if (scrubbing.current && event.buttons & 1 && !disabled) pick.current(choice.value); }}
            onClick={event => {
                if (event.detail !== 0 || disabled) return;
                commands.beginGesture(undo);
                pick.current(choice.value);
                commands.endGesture();
                settled.current?.();
            }}>
            {choice.icon}
        </button>)}
    </div>;
}

interface DisclosureProps<T extends string> {
    readonly label: string;
    readonly current: Shared<T>;
    readonly currentIcon: (value: T) => ReactNode;
    readonly currentText?: (value: T) => string;
    readonly choices: readonly Choice<T>[];
    readonly columns: number;
    readonly disabled: boolean;
    readonly undo: string;
    readonly commands: StyleCommands;
    readonly onPick: (value: T) => void;
    readonly mixedLabel: string;
}

function Disclosure<T extends string>({ label, current, currentIcon, currentText, choices, columns, disabled, undo, commands, onPick, mixedLabel }: DisclosureProps<T>) {
    const [open, setOpen] = useState(false);
    const id = useId();
    return <div className="board-style-disclosure">
        <button type="button" className="board-style-disclosure-button" aria-label={label} aria-expanded={open} aria-controls={id}
            data-tooltip={label} disabled={disabled} onClick={() => setOpen(value => !value)}>
            <span className="board-style-disclosure-current">
                {current === MIXED ? <span className="board-style-mixed-text">{mixedLabel}</span>
                    : current === null ? null : <>{currentIcon(current)}{currentText && <span className="board-style-disclosure-name">{currentText(current)}</span>}</>}
            </span>
            <span className="board-style-caret" aria-hidden="true"><StyleGlyph kind="caret" /></span>
        </button>
        {open && <div id={id} className="board-style-disclosure-panel">
            <ChoiceGroup label={label} choices={choices} selected={current} columns={columns} disabled={disabled} undo={undo}
                commands={commands} onPick={onPick} onSettled={() => setOpen(false)} />
        </div>}
    </div>;
}

function WidthRow({ position, mixed, label, mixedLabel, disabled, commands }: {
    readonly position: number; readonly mixed: boolean; readonly label: string; readonly mixedLabel: string;
    readonly disabled: boolean; readonly commands: StyleCommands;
}) {
    const dragging = useRef(false), opened = useRef(false), timer = useRef<number | null>(null), keyPosition = useRef<number | null>(null);
    const commitRef = useRef(commands);
    useEffect(() => { commitRef.current = commands; }, [commands]);
    const finish = () => {
        if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
        dragging.current = false;
        if (opened.current) { opened.current = false; commitRef.current.endGesture(); }
    };
    useEffect(() => () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        if (opened.current) { opened.current = false; commitRef.current.endGesture(); }
    }, []);
    const deferFinish = () => {
        if (!dragging.current) return;
        dragging.current = false;
        timer.current = window.setTimeout(finish, 500);
    };
    const setPosition = (value: number) => commands.setWidth(penScaleFromSlider(value));
    return <input type="range" min={0} max={1} step={0.001} value={position} aria-label={label} aria-valuetext={mixed ? mixedLabel : undefined}
        data-tooltip={label} disabled={disabled} className="board-style-width"
        onKeyDown={event => {
            if (disabled) return;
            const delta = KEY_STEP[event.key];
            if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return;
            event.preventDefault();
            if (!opened.current) {
                if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
                commands.beginGesture(WIDTH_UNDO); opened.current = true;
            }
            const base = keyPosition.current ?? position;
            const value = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : Math.min(1, Math.max(0, base + delta!));
            keyPosition.current = value;
            setPosition(value);
        }}
        onKeyUp={() => { if (keyPosition.current !== null) { keyPosition.current = null; finish(); } }}
        onBlur={finish}
        onPointerDown={event => {
            if (opened.current && event.detail !== 2) finish();
            if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
            if (!opened.current) { commands.beginGesture(WIDTH_UNDO); opened.current = true; }
            dragging.current = true;
        }}
        onPointerUp={deferFinish}
        onPointerCancel={finish}
        onLostPointerCapture={deferFinish}
        onChange={event => {
            if (!dragging.current && keyPosition.current === null) { finish(); commands.beginGesture(WIDTH_UNDO); opened.current = true; }
            setPosition(Number(event.currentTarget.value));
            if (!dragging.current && keyPosition.current === null) finish();
        }}
        onDoubleClick={() => {
            if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
            dragging.current = false;
            try { commands.beginGesture(WIDTH_UNDO); commands.setWidth(1); }
            finally { if (opened.current) { opened.current = false; } commands.endGesture(); }
        }} />;
}

function Section({ label, subheadings, mixed, mixedLabel, children }: {
    readonly label: string; readonly subheadings: boolean; readonly mixed: boolean; readonly mixedLabel: string; readonly children: ReactNode;
}) {
    return <section className="board-style-section" aria-label={label} data-mixed={mixed || undefined}>
        {(subheadings || mixed) && <header className="board-style-heading">
            {subheadings && <span>{label}</span>}
            {mixed && <span className="board-style-mixed-text">{mixedLabel}</span>}
        </header>}
        {children}
    </section>;
}

function StyleRows({ snapshot, commands, toolLabel, subheadings }: StylePanelProps) {
    const t = snapshot.translate, disabled = snapshot.disabled, rows = snapshot.rows;
    const has = (row: StyleRow) => rows.includes(row);
    const mixedLabel = t('styles.mixed');
    const choice = <K extends string | number>(value: K, label: string, icon: ReactNode): Choice<K> => ({ value, label, icon });
    const group = <K extends string | number>(label: string, row: string, shared: Shared<K>, choices: readonly Choice<K>[], columns: number,
        pick: (value: K) => void, undo: string, key?: string) => <Section key={key ?? row} label={label} subheadings={subheadings}
        mixed={shared === MIXED} mixedLabel={mixedLabel}>
        <ChoiceGroup label={label} choices={choices} selected={shared} columns={columns} disabled={disabled} undo={undo}
            commands={commands} onPick={pick} />
    </Section>;
    const sections: ReactNode[] = [];
    if (has('colour')) {
        const colourLabel = t('styles.colour');
        const shared = snapshot.colour;
        sections.push(<Section key="colour" label={colourLabel} subheadings={subheadings} mixed={shared === MIXED} mixedLabel={mixedLabel}>
            <ChoiceGroup label={colourLabel} columns={4} disabled={disabled} undo="Change colour" commands={commands}
                selected={shared} onPick={(id: Swatch) => commands.setColor(id)}
                choices={snapshot.swatches.map(swatch => choice(swatch.id, t(`colours.${swatch.id}`),
                    <span className="board-style-chip" style={{ background: swatch.css }} />))} />
        </Section>);
    }
    if (has('opacity')) {
        sections.push(group(t('styles.opacity'), 'opacity', snapshot.opacity,
            OPACITIES.map(value => choice(value, `${Math.round(value * 100)}%`, <span className="board-style-percent">{Math.round(value * 100)}%</span>)),
            5, value => commands.setOpacity(value), 'Change opacity'));
    }
    if (has('fill')) {
        sections.push(group(t('styles.fill'), 'fill', snapshot.fill, FILLS.map(value => choice(value, t(FILL_KEYS[value]), <StyleGlyph kind="fill" value={value} />))
            , 3, value => commands.setFill(value), 'Change fill'));
    }
    if (has('dash')) {
        sections.push(group(t('styles.dash'), 'dash', snapshot.dash, DASHES.filter(value => value !== 'none')
            .map(value => choice(value, t(DASH_KEYS[value as Exclude<Dash, 'none'>]), <StyleGlyph kind="dash" value={value} />)),
            4, value => commands.setDash(value), 'Change dash style'));
    }
    if (has('size')) {
        sections.push(group(t('styles.size'), 'size', snapshot.size, SIZES.map(value => choice(value, t(SIZE_KEYS[value]), <StyleGlyph kind="size" value={value} />))
            , 4, value => commands.setSize(value), 'Change style size'));
    }
    if (has('width')) {
        sections.push(<Section key="width" label={t('chrome.penWidth')} subheadings={subheadings} mixed={snapshot.width.mixed} mixedLabel={mixedLabel}>
            <WidthRow position={snapshot.width.position} mixed={snapshot.width.mixed} label={t('chrome.penWidth')} mixedLabel={mixedLabel}
                disabled={disabled} commands={commands} />
        </Section>);
    }
    if (has('font')) {
        sections.push(group(t('styles.font'), 'font', snapshot.font, FONTS.map(value => choice(value, t(value === 'draw' ? 'styles.draw' : `styles.${value}`),
            <span className="board-style-font" style={{ fontFamily: FONT_FAMILY[value] }}>Aa</span>))
            , 4, value => commands.setFont(value), 'Change font'));
    }
    if (has('textAlign')) {
        sections.push(group(t('styles.alignment'), 'textAlign', snapshot.textAlign, (['start', 'middle', 'end'] as const)
            .map(value => choice(value, t(ALIGN_KEYS[value]), <StyleGlyph kind="align" value={value} />)), 3, value => commands.setTextAlignment(value), 'Change alignment'));
    }
    if (has('labelAlign')) {
        const label = t('styles.labelAlignment');
        sections.push(<Section key="labelAlign" label={label} subheadings={subheadings}
            mixed={snapshot.labelAlign === MIXED || snapshot.labelVAlign === MIXED} mixedLabel={mixedLabel}>
            <div className="board-style-pair">
                <ChoiceGroup label={t('styles.alignment')} columns={3} disabled={disabled} undo="Change label alignment" commands={commands}
                    selected={snapshot.labelAlign} onPick={(value: HAlign) => commands.setLabelAlignment(value)}
                    choices={(['start', 'middle', 'end'] as const).map(value => choice(value, t(ALIGN_KEYS[value]), <StyleGlyph kind="align" value={value} />))} />
                <ChoiceGroup label={t('styles.verticalAlignment')} columns={3} disabled={disabled} undo="Change vertical alignment" commands={commands}
                    selected={snapshot.labelVAlign} onPick={(value: VAlign) => commands.setVerticalAlignment(value)}
                    choices={V_ALIGNS.map(value => choice(value, t(VALIGN_KEYS[value]), <StyleGlyph kind="valign" value={value} />))} />
            </div>
        </Section>);
    }
    if (has('shape')) {
        const label = t('styles.shape');
        sections.push(<Section key="shape" label={label} subheadings={subheadings} mixed={false} mixedLabel={mixedLabel}>
            <Disclosure<FigureShape> label={label} current={snapshot.shape} mixedLabel={mixedLabel} columns={5} disabled={disabled}
                undo="Change shape" commands={commands} onPick={shape => commands.setShape(shape)}
                currentIcon={shape => <ToolIcon id="figure" figure={shape} />} currentText={shape => toolLabel(shapeToolLabel(shape))}
                choices={FIGURE_SHAPES.map(shape => choice(shape, toolLabel(shapeToolLabel(shape)), <ToolIcon id="figure" figure={shape} />))} />
        </Section>);
    }
    if (has('route')) {
        sections.push(group(t('styles.lineKind'), 'route', snapshot.route, (['arc', 'elbow'] as const)
            .map(value => choice(value, t(value === 'arc' ? 'styles.arc' : 'styles.elbow'), <StyleGlyph kind="route" value={value} />))
            , 2, value => commands.setRoute(value), 'Change arrow kind'));
    }
    if (has('heads')) {
        for (const end of ['start', 'end'] as const) {
            const label = t(end === 'start' ? 'styles.arrowheadStart' : 'styles.arrowheadEnd');
            const current = end === 'start' ? snapshot.headStart : snapshot.headEnd;
            sections.push(<Section key={`head-${end}`} label={label} subheadings={subheadings} mixed={false} mixedLabel={mixedLabel}>
                <Disclosure<Arrowhead> label={label} current={current} mixedLabel={mixedLabel} columns={3} disabled={disabled}
                    undo={end === 'start' ? 'Change start arrowhead' : 'Change end arrowhead'} commands={commands}
                    onPick={head => commands.setArrowhead(end, head)} currentIcon={head => <StyleGlyph kind="head" value={head} />}
                    choices={ARROWHEADS.map(head => choice(head, t(HEAD_KEYS[head]), <StyleGlyph kind="head" value={head} />))} />
            </Section>);
        }
    }
    if (has('spline')) {
        sections.push(group(t('styles.lineType'), 'spline', snapshot.spline, (['line', 'cubic'] as const)
            .map(value => choice(value, t(value === 'line' ? 'styles.straight' : 'styles.smooth'), <StyleGlyph kind="spline" value={value} />))
            , 2, value => commands.setSpline(value), 'Change line type'));
    }
    return <div className="board-style-rows" data-enhanced={subheadings || undefined}>{sections}</div>;
}

function shapeToolLabel(shape: FigureShape): ToolLabel {
    return shape.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase()) as ToolLabel;
}

function fitRowsToWholeSections(dock: HTMLElement | null): void {
    const rows = dock?.querySelector<HTMLElement>('.board-style-rows'), panel = dock?.querySelector<HTMLElement>('.board-style-panel');
    if (!dock || !rows || !panel) return;
    rows.style.maxHeight = '';
    const top = rows.getBoundingClientRect().top, panelStyle = getComputedStyle(panel), rowStyle = getComputedStyle(rows);
    const room = dock.getBoundingClientRect().bottom - parseFloat(panelStyle.paddingBottom) - parseFloat(panelStyle.borderBottomWidth) - top;
    let fit: number | null = null;
    for (const choice of rows.querySelectorAll<HTMLElement>('.board-style-choice')) {
        const bottom = choice.getBoundingClientRect().bottom - top + rows.scrollTop;
        if (bottom <= room && (fit === null || bottom > fit)) fit = bottom;
    }
    if (fit === null) return;
    const padding = rowStyle.boxSizing === 'border-box' ? 0 : parseFloat(rowStyle.paddingTop) + parseFloat(rowStyle.paddingBottom);
    rows.style.maxHeight = `${Math.max(0, fit - padding)}px`;
}

export function DockedStylePanel(props: StylePanelProps) {
    const { snapshot } = props, t = snapshot.translate;
    const collapsed = useSyncExternalStore(subscribeStylePanel, getStylePanelCollapsed, getStylePanelCollapsed);
    const rootRef = useRef<HTMLDivElement>(null), latest = useRef(props);
    useEffect(() => { latest.current = props; });
    useLayoutEffect(() => { fitRowsToWholeSections(rootRef.current); });
    useEffect(() => {
        const dock = rootRef.current;
        if (!dock || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => fitRowsToWholeSections(dock));
        observer.observe(dock);
        return () => observer.disconnect();
    }, []);
    useEffect(() => registerStylePanelFocus(() => {
        const root = rootRef.current, current = latest.current;
        if (!root || current.snapshot.disabled || !current.snapshot.rows.length || root.offsetParent === null) return false;
        if (getStylePanelCollapsed()) setStylePanelCollapsed(false);
        requestAnimationFrame(() => root.querySelector<HTMLElement>('.board-style-panel button:not(:disabled), .board-style-panel input:not(:disabled)')?.focus());
        return true;
    }), []);
    if (!snapshot.rows.length) return null;
    const toggleLabel = collapsed ? t('chrome.showColours') : t('chrome.hideColours');
    return <div className="board-style-dock" ref={rootRef} onKeyDown={event => {
        if (panelHistoryKey(event, props.history)) return;
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault(); event.stopPropagation();
        returnToBoard(event.currentTarget);
    }}>
        <div className="board-style-panel" role="group" aria-label={t('styles.panel')} data-disabled={snapshot.disabled || undefined}
            data-collapsed={collapsed || undefined}>
            <header className="board-style-panel-head">
                <span className="board-style-panel-title">{t('styles.panel')}</span>
                {collapsed && <span className="board-style-indicator" aria-hidden="true"
                    style={{ background: snapshot.colour === MIXED || snapshot.colour === null ? snapshot.nextColourCss
                        : snapshot.swatches.find(swatch => swatch.id === snapshot.colour)?.css ?? snapshot.nextColourCss,
                    outlineColor: snapshot.indicatorOutline }} />}
                <button type="button" className="board-style-toggle" aria-label={toggleLabel} data-tooltip={toggleLabel}
                    aria-expanded={!collapsed} onClick={() => setStylePanelCollapsed(!collapsed)}>
                    <StyleGlyph kind="caret" />
                </button>
            </header>
            {!collapsed && <StyleRows {...props} />}
        </div>
    </div>;
}

export function StylePopoverAnchor(props: StylePanelProps) {
    const { snapshot } = props, t = snapshot.translate;
    const [open, setOpen] = useState(false);
    const anchor = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), latest = useRef(props);
    useEffect(() => { latest.current = props; });
    const disabled = snapshot.disabled || !snapshot.rows.length || NO_STYLE_TOOLS.has(snapshot.tool);
    useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
    useEffect(() => {
        if (!open) return;
        const onPointer = (event: globalThis.PointerEvent) => {
            if (!anchor.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', onPointer);
        const dismiss = dismissOnEscape(() => setOpen(false));
        return () => { document.removeEventListener('pointerdown', onPointer); dismiss(); };
    }, [open]);
    useEffect(() => registerStylePanelFocus(() => {
        const current = latest.current;
        if (!button.current || button.current.offsetParent === null || current.snapshot.disabled || !current.snapshot.rows.length) return false;
        if (NO_STYLE_TOOLS.has(current.snapshot.tool)) return false;
        setOpen(true);
        requestAnimationFrame(() => anchor.current?.querySelector<HTMLElement>('.board-style-popover button:not(:disabled), .board-style-popover input:not(:disabled)')?.focus());
        return true;
    }), []);
    const mixed = snapshot.colour === MIXED || snapshot.colour === null;
    const tint = mixed ? snapshot.nextColourCss : snapshot.swatches.find(swatch => swatch.id === snapshot.colour)?.css ?? snapshot.nextColourCss;
    const label = t('styles.panel');
    return <div className="board-style-popover-anchor" ref={anchor}>
        <button ref={button} type="button" className="board-chrome-tool board-style-popover-button" aria-label={label} data-tooltip={label}
            aria-haspopup="dialog" aria-expanded={open} disabled={disabled} style={{ '--style-tint': tint } as CSSProperties}
            onClick={() => setOpen(value => !value)}>
            <span className="board-style-popover-glyph" aria-hidden="true">{snapshot.colour === MIXED ? <StyleGlyph kind="mixed" /> : <StyleGlyph kind="palette" />}</span>
        </button>
        {open && <div className="board-style-popover" role="dialog" aria-label={label} onKeyDown={event => {
            if (panelHistoryKey(event, props.history)) return;
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault(); event.stopPropagation();
            setOpen(false); returnToBoard(event.currentTarget);
        }}>
            <StyleRows {...props} />
        </div>}
    </div>;
}
