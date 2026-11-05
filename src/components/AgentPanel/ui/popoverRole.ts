// What the open popover is to assistive tech, read by the rows inside it.
//
// A pure list of actions is a `menu` and its rows are menuitems. A surface
// that also holds a field, a segmented control or a per-row button (chats with
// its search, model + effort, Learning mode, the title menu's rename form) is a
// `dialog`: a menu may own only menuitems, so axe failed every one of those
// with aria-required-children (measured: chats, model, sliders). In a dialog a
// row is a plain button — or a radio, for a pick-one row.

import { createContext } from 'react';

export type PopoverRole = 'menu' | 'dialog';

export const PopoverRoleContext = createContext<PopoverRole>('menu');
