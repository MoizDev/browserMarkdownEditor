import type { NotebookPaper } from '../../utils/paper';
import type { BoardKey, NodePropKey } from '../change/ops';
import type { UiBlock } from './styles';

// R-W23: raw entries name exactly one native record token. The encoder and CH-1
// share this mapping, so a property set cannot leave an older raw token in charge.
export const NODE_FILE_FIELDS = {
    parent: ['parent'], order: ['order'], page: ['page'], x: ['x'], y: ['y'],
    rotation: ['rot'], locked: ['locked'], opacity: ['opacity'],
    tool: ['tool'], samples: ['pts'], pressure: ['pts'], widthModel: ['widthModel'],
    geomVersion: ['geomVersion'], fairTol: ['fairTol'], closed: ['closed'], width: ['width'],
    sx: ['sx'], sy: ['sy'], color: ['color'], fill: ['fill'], dash: ['dash'], complete: ['complete'],
    shape: ['shape'], w: ['w'], h: ['h'], growY: ['growY'], labelColor: ['labelColor'],
    size: ['size'], font: ['font'], align: ['align'], valign: ['valign'], label: ['label'],
    labelScale: ['labelScale'], flipX: ['flipX'], flipY: ['flipY'], url: ['url'], text: ['text'],
    autoSize: ['autoSize'], scale: ['scale'], fit: ['fit'], route: ['route'], start: ['start'],
    end: ['end'], bend: ['bend'], elbowMid: ['elbowMid'], headStart: ['headStart'],
    headEnd: ['headEnd'], labelAt: ['labelAt'], points: ['points'], spline: ['spline'],
    name: ['name'], media: ['media'], crop: ['crop'], alt: ['alt'], inverted: ['inverted'],
    playing: ['playing'], time: ['time'], autoplay: ['autoplay'], preview: ['preview'],
} as const satisfies Record<NodePropKey, readonly [string, ...string[]]>;

export const PEN_FILE_FIELDS = {
    tool: ['tool'], penWidth: ['width'], next: ['color', 'next'],
} as const satisfies Record<Exclude<keyof UiBlock, 'ext'>, readonly [string, ...string[]]>;

export const PAPER_FILE_FIELDS = {
    size: ['size'], orientation: ['orientation'], ruling: ['ruling'], spacing: ['spacing'],
    margin: ['margin'], pageCount: ['pages'],
} as const satisfies Record<keyof NotebookPaper, readonly [string, ...string[]]>;

export const BOARD_FILE_FIELDS = {
    'host.paper': Object.values(PAPER_FILE_FIELDS).flat(),
    'host.pdf': ['pdf'],
    'ui.tool': PEN_FILE_FIELDS.tool,
    'ui.next': PEN_FILE_FIELDS.next,
    'ui.penWidth': PEN_FILE_FIELDS.penWidth,
    'view.grid': ['grid'], 'view.focusMode': ['focusMode'], 'view.toolLock': ['toolLock'],
    'view.transparent': ['transparent'], 'view.debugMode': ['debugMode'],
} as const satisfies Record<BoardKey, readonly string[]>;
