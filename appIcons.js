/*
 * This file is part of the Dash-To-Panel extension for Gnome 3
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 *
 * Credits:
 * This file is based on code from the Dash to Dock extension by micheleg
 * and code from the Taskbar extension by Zorin OS
 * Some code was also adapted from the upstream Gnome Shell source code.
 */


const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Signals = imports.signals;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Mainloop = imports.mainloop;

const Config = imports.misc.config;
const AppDisplay = imports.ui.appDisplay;
const AppFavorites = imports.ui.appFavorites;
const Dash = imports.ui.dash;
const DND = imports.ui.dnd;
const IconGrid = imports.ui.iconGrid;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Tweener = imports.ui.tweener;
const Util = imports.misc.util;
const Workspace = imports.ui.workspace;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Utils = Me.imports.utils;
const Taskbar = Me.imports.taskbar;
const _ = imports.gettext.domain(Utils.TRANSLATION_DOMAIN).gettext;

let DASH_ANIMATION_TIME = Dash.DASH_ANIMATION_TIME;
let DASH_ITEM_LABEL_SHOW_TIME = Dash.DASH_ITEM_LABEL_SHOW_TIME;
let DASH_ITEM_LABEL_HIDE_TIME = Dash.DASH_ITEM_LABEL_HIDE_TIME;
let DASH_ITEM_HOVER_TIMEOUT = Dash.DASH_ITEM_HOVER_TIMEOUT;
let LABEL_GAP = 5;
let MAX_INDICATORS = 4;

let DOT_STYLE = {
    DOTS: "DOTS",
    SQUARES: "SQUARES",
    DASHES: "DASHES",
    SEGMENTED: "SEGMENTED",
    CILIORA: "CILIORA",
    METRO: "METRO",
    SOLID: "SOLID"
}

let DOT_POSITION = {
    TOP: "TOP",
    BOTTOM: "BOTTOM"
}

let recentlyClickedAppLoopId = 0;
let recentlyClickedApp = null;
let recentlyClickedAppWindows = null;
let recentlyClickedAppIndex = 0;
let recentlyClickedAppMonitorIndex;

let tracker = Shell.WindowTracker.get_default();

/**
 * Extend AppIcon
 *
 * - Apply a css class based on the number of windows of each application (#N);
 * - Draw a dot for each window of the application based on the default "dot" style which is hidden (#N);
 *   a class of the form "running#N" is applied to the AppWellIcon actor.
 *   like the original .running one.
 * - add a .focused style to the focused app
 * - Customize click actions.
 * - Update minimization animation target
 *
 */

var taskbarAppIcon = Utils.defineClass({
    Name: 'DashToPanel.TaskbarAppIcon',
    Extends: AppDisplay.AppIcon,
    ParentConstrParams: [[1, 'app'], [3]],

    _init: function(settings, appInfo, panelWrapper, iconParams, previewMenu) {

        // a prefix is required to avoid conflicting with the parent class variable
        this._dtpSettings = settings;
        this.panelWrapper = panelWrapper;
        this._nWindows = 0;
        this.window = appInfo.window;
        this.isLauncher = appInfo.isLauncher;
        this._previewMenu = previewMenu;

		// Fix touchscreen issues before the listener is added by the parent constructor.
        this._onTouchEvent = function(actor, event) {
            if (event.type() == Clutter.EventType.TOUCH_BEGIN) {
                // Open the popup menu on long press.
                this._setPopupTimeout();
            } else if (this._menuTimeoutId != 0 && (event.type() == Clutter.EventType.TOUCH_END || event.type() == Clutter.EventType.TOUCH_CANCEL)) {    
                // Activate/launch the application.
                this.activate(1);
                this._removeMenuTimeout();
            }
            // Disable dragging via touch screen as it's buggy as hell. Not perfect for tablet users, but the alternative is way worse.
            // Also, EVENT_PROPAGATE launches applications twice with this solution, so this.activate(1) above must only be called if there's already a window.
            return Clutter.EVENT_STOP;
        };
        // Hack for missing TOUCH_END event.
        this._onLeaveEvent = function(actor, event) {
            this.actor.fake_release();
            if (this._menuTimeoutId != 0) this.activate(1); // Activate/launch the application if TOUCH_END didn't fire.
            this._removeMenuTimeout();
        };

        this.callParent('_init', appInfo.app, iconParams);

        Utils.wrapActor(this.icon);
        
        this._dot.set_width(0);
        this._isGroupApps = this._dtpSettings.get_boolean('group-apps');

        this._container = new St.Widget({ style_class: 'dtp-container', layout_manager: new Clutter.BinLayout() });
        this._dotsContainer = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        this._dtpIconContainer = new St.Widget({ style_class: 'dtp-icon-container', layout_manager: new Clutter.BinLayout()});

        this.actor.remove_actor(this._iconContainer);
        
        this._dtpIconContainer.add_child(this._iconContainer);

        if (appInfo.window) {
            let box = new St.BoxLayout();
            
            this._windowTitle = new St.Label({ 
                y_align: Clutter.ActorAlign.CENTER, 
                x_align: Clutter.ActorAlign.START, 
                style_class: 'overview-label' 
            });
            
            this._updateWindowTitle();
            this._updateWindowTitleStyle();

            this._scaleFactorChangedId = St.ThemeContext.get_for_stage(global.stage).connect('changed', () => this._updateWindowTitleStyle());

            box.add_child(this._dtpIconContainer);
            box.add_child(this._windowTitle);

            this._dotsContainer.add_child(box);
        } else {
            this._dotsContainer.add_child(this._dtpIconContainer);
        }

        this._container.add_child(this._dotsContainer);
        this.actor.set_child(this._container);

        // Monitor windows-changes instead of app state.
        // Keep using the same Id and function callback (that is extended)
        if(this._stateChangedId > 0) {
            this.app.disconnect(this._stateChangedId);
            this._stateChangedId = 0;
        }

        this._setAppIconPadding();
        this._showDots();

        this._focusWindowChangedId = global.display.connect('notify::focus-window', 
                                                            Lang.bind(this, this._onFocusAppChanged));

        this._windowEnteredMonitorId = this._windowLeftMonitorId = 0;
        this._stateChangedId = this.app.connect('windows-changed', Lang.bind(this, this.onWindowsChanged));

        if (!this.window) {
            if (this._dtpSettings.get_boolean('isolate-monitors')) {
                this._windowEnteredMonitorId = Utils.DisplayWrapper.getScreen().connect('window-entered-monitor', this.onWindowEnteredOrLeft.bind(this));
                this._windowLeftMonitorId = Utils.DisplayWrapper.getScreen().connect('window-left-monitor', this.onWindowEnteredOrLeft.bind(this));
            }
            
            this._titleWindowChangeId = 0;
        } else {
            this._titleWindowChangeId = this.window.connect('notify::title', 
                                                Lang.bind(this, this._updateWindowTitle));
        }
        
        this._scrollEventId = this.actor.connect('scroll-event', this._onMouseScroll.bind(this));

        this._overviewWindowDragEndId = Main.overview.connect('window-drag-end',
                                                Lang.bind(this, this._onOverviewWindowDragEnd));

        this._switchWorkspaceId = global.window_manager.connect('switch-workspace',
                                                Lang.bind(this, this._onSwitchWorkspace));

        this._hoverChangeId = this.actor.connect('notify::hover', () => this._onAppIconHoverChanged());
        
        this._dtpSettingsSignalIds = [
            this._dtpSettings.connect('changed::dot-position', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::dot-size', Lang.bind(this, this._updateDotSize)),
            this._dtpSettings.connect('changed::dot-style-focused', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::dot-style-unfocused', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::dot-color-dominant', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::dot-color-override', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::dot-color-1', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::dot-color-2', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::dot-color-3', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::dot-color-4', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::dot-color-unfocused-different', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::dot-color-unfocused-1', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::dot-color-unfocused-2', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::dot-color-unfocused-3', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::dot-color-unfocused-4', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::focus-highlight', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::focus-highlight-dominant', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::focus-highlight-color', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::focus-highlight-opacity', Lang.bind(this, this._settingsChangeRefresh)),
            this._dtpSettings.connect('changed::group-apps-label-font-size', Lang.bind(this, this._updateWindowTitleStyle)),
            this._dtpSettings.connect('changed::group-apps-label-font-weight', Lang.bind(this, this._updateWindowTitleStyle)),
            this._dtpSettings.connect('changed::group-apps-label-font-color', Lang.bind(this, this._updateWindowTitleStyle)),
            this._dtpSettings.connect('changed::group-apps-label-max-width', Lang.bind(this, this._updateWindowTitleStyle)),
            this._dtpSettings.connect('changed::group-apps-use-fixed-width', Lang.bind(this, this._updateWindowTitleStyle)),
            this._dtpSettings.connect('changed::group-apps-underline-unfocused', Lang.bind(this, this._settingsChangeRefresh))
        ]

        this.forcedOverview = false;

        this._numberOverlay();
    },

    shouldShowTooltip: function() {
        if (!this._dtpSettings.get_boolean('show-tooltip') || 
            (!this.isLauncher && this._dtpSettings.get_boolean("show-window-previews") &&
             this.getAppIconInterestingWindows().length > 0)) {
            return false;
        } else {
            return this.actor.hover && !this.window && 
                   (!this._menu || !this._menu.isOpen) && 
                   (this._previewMenu.getCurrentAppIcon() !== this);
        }
    },

    _onAppIconHoverChanged: function() {
        if (this._dtpSettings.get_boolean('show-window-previews') || 
            (this.window && this._nWindows)) {
            this._openClosePreviewWindow(true);
            return;
        }

        if ((this._dtpSettings.get_string('click-action') == 'TOGGLE-SHOWPREVIEW') ||
            (this._dtpSettings.get_string('shift-click-action') == 'TOGGLE-SHOWPREVIEW') ||
            (this._dtpSettings.get_string('middle-click-action') == 'TOGGLE-SHOWPREVIEW') ||
            (this._dtpSettings.get_string('shift-middle-click-action') == 'TOGGLE-SHOWPREVIEW')) {
            // If opening, only allow opening of the preview window, if the preview window is already opened
            // This is necessary in combination with the TOGGLE-SHOWPREVIEW action
            this._openClosePreviewWindow(this._previewMenu.getOpenedState());
        }
    },

    /*
    * Open (if allowed) or close the window overview
    */    
    _openClosePreviewWindow: function(allowOpening) {
        if (this.actor.hover) {
            if (allowOpening)
                this._previewMenu.requestOpen(this);
            else
                return;
        } else
            this._previewMenu.requestClose();
    },

    _onDestroy: function() {
        this.callParent('_onDestroy');
        this._destroyed = true;

        this._previewMenu.close(true);

        // Disconect global signals
        // stateChangedId is already handled by parent)
        
        if(this._overviewWindowDragEndId)
            Main.overview.disconnect(this._overviewWindowDragEndId);

        if(this._focusWindowChangedId)
            global.display.disconnect(this._focusWindowChangedId);

        if(this._titleWindowChangeId)
            this.window.disconnect(this._titleWindowChangeId);

        if (this._windowEnteredMonitorId) {
            Utils.DisplayWrapper.getScreen().disconnect(this._windowEnteredMonitorId);
            Utils.DisplayWrapper.getScreen().disconnect(this._windowLeftMonitorId);
        }
        
        if(this._switchWorkspaceId)
            global.window_manager.disconnect(this._switchWorkspaceId);

        if(this._scaleFactorChangedId)
            St.ThemeContext.get_for_stage(global.stage).disconnect(this._scaleFactorChangedId);

        if (this._hoverChangeId) {
            this.actor.disconnect(this._hoverChangeId);
        }

        if (this._scrollEventId) {
            this.actor.disconnect(this._scrollEventId);
        }

        for (let i = 0; i < this._dtpSettingsSignalIds.length; ++i) {
            this._dtpSettings.disconnect(this._dtpSettingsSignalIds[i]);
        }
    },

    onWindowsChanged: function() {
        this._updateWindows();
        this.updateIcon();
    },

    onWindowEnteredOrLeft: function() {
        if (this._checkIfFocusedApp()) {
            this._updateWindows();
            this._displayProperIndicator();
        }
    },

    // Update indicator and target for minimization animation
    updateIcon: function() {

        // If (for unknown reason) the actor is not on the stage the reported size
        // and position are random values, which might exceeds the integer range
        // resulting in an error when assigned to the a rect. This is a more like
        // a workaround to prevent flooding the system with errors.
        if (this.actor.get_stage() == null)
            return;

        let rect = new Meta.Rectangle();

        [rect.x, rect.y] = this.actor.get_transformed_position();
        [rect.width, rect.height] = this.actor.get_transformed_size();

        let windows = this.window ? [this.window] : this.getAppIconInterestingWindows(true);
        windows.forEach(function(w) {
            w.set_icon_geometry(rect);
        });
    },

    _onMouseScroll: function(actor, event) {
        if (!this.window && !this._nWindows) {
            return;
        }

        let direction = Utils.getMouseScrollDirection(event);

        if (direction) {
            let windows = this.getAppIconInterestingWindows();
            
            windows.sort(Taskbar.sortWindowsCompareFunction);

            let windowIndex = windows.indexOf(global.display.focus_window);
            let nextWindowIndex = windowIndex < 0 ?
                                  this.window ? windows.indexOf(this.window) : 0 : 
                                  windowIndex + (direction == 'up' ? 1 : -1);

            if (nextWindowIndex == windows.length) {
                nextWindowIndex = 0;
            } else if (nextWindowIndex < 0) {
                nextWindowIndex = windows.length - 1;
            }

            if (windowIndex != nextWindowIndex) {
                Main.activateWindow(windows[nextWindowIndex]);
            }
        }
    },
    
    _showDots: function() {
        // Just update style if dots already exist
        if (this._focusedDots && this._unfocusedDots) {
            this._updateWindows();
            return;
        }

        if (!this._isGroupApps) {
            this._focusedDots = new St.Widget({ 
                layout_manager: new Clutter.BinLayout(),
                x_expand: true, y_expand: true,
                height: this._getRunningIndicatorHeight(),
                visible: false
            });

            let mappedId = this.actor.connect('notify::mapped', () => {
                this._displayProperIndicator();
                this.actor.disconnect(mappedId);
            });
        } else {
            this._focusedDots = new St.DrawingArea({ width:1, y_expand: true });
            this._focusedDots._tweeningToWidth = null;
            this._unfocusedDots = new St.DrawingArea({width:1, y_expand: true});
            this._unfocusedDots._tweeningToWidth = null;
            
            this._focusedDots.connect('repaint', Lang.bind(this, function() {
                if(this._dashItemContainer.animatingOut) {
                    // don't draw and trigger more animations if the icon is in the middle of
                    // being added to the panel
                    return;
                }
                this._drawRunningIndicator(this._focusedDots, this._dtpSettings.get_string('dot-style-focused'), true);
                this._displayProperIndicator();
            }));
            
            this._unfocusedDots.connect('repaint', Lang.bind(this, function() {
                if(this._dashItemContainer.animatingOut) {
                    // don't draw and trigger more animations if the icon is in the middle of
                    // being added to the panel
                    return;
                }
                this._drawRunningIndicator(this._unfocusedDots, this._dtpSettings.get_string('dot-style-unfocused'), false);
                this._displayProperIndicator();
            }));
                
            this._dotsContainer.add_child(this._unfocusedDots);
    
            this._updateWindows();
        }

        this._dotsContainer.add_child(this._focusedDots);
    },

    _updateDotSize: function() {
        if (!this._isGroupApps) {
            this._focusedDots.height = this._getRunningIndicatorHeight();
        }

        this._settingsChangeRefresh();
    },

    _settingsChangeRefresh: function() {
        if (this._isGroupApps) {
            this._updateWindows();
            this._focusedDots.queue_repaint();
            this._unfocusedDots.queue_repaint();
        }

        this._displayProperIndicator(true);
    },

    _updateWindowTitleStyle: function() {
        if (this._windowTitle) {
            let useFixedWidth = this._dtpSettings.get_boolean('group-apps-use-fixed-width');
            let maxLabelWidth = this._dtpSettings.get_int('group-apps-label-max-width') * 
                                St.ThemeContext.get_for_stage(global.stage).scale_factor;
            let fontWeight = this._dtpSettings.get_string('group-apps-label-font-weight');
            
            this._windowTitle[(maxLabelWidth > 0 ? 'show' : 'hide')]();

            this._windowTitle.clutter_text.natural_width = useFixedWidth ? maxLabelWidth : 0;
            this._windowTitle.clutter_text.natural_width_set = useFixedWidth;
            this._windowTitle.set_style('font-size: ' + this._dtpSettings.get_int('group-apps-label-font-size') + 'px;' +
                                        'font-weight: ' + fontWeight + ';' +
                                        (useFixedWidth ? '' : 'max-width: ' + maxLabelWidth + 'px;') + 
                                        'color: ' + this._dtpSettings.get_string('group-apps-label-font-color'));
        }
    },

    _updateWindowTitle: function() {
        if (this._windowTitle.text != this.window.title) {
            this._windowTitle.text = (this.window.title ? this.window.title : this.app.get_name()).replace(/\r?\n|\r/g, '').trim();
            
            if (this._focusedDots) {
                this._displayProperIndicator();
            }
        }
    },

    _setIconStyle: function(isFocused) {
        let inlineStyle = 'margin: 0;';

        if(this._dtpSettings.get_boolean('focus-highlight') && 
           this._checkIfFocusedApp() && !this.isLauncher &&  
           (!this.window || isFocused) && !this._isThemeProvidingIndicator() && this._checkIfMonitorHasFocus()) {
            let focusedDotStyle = this._dtpSettings.get_string('dot-style-focused');
            let isWide = this._isWideDotStyle(focusedDotStyle);
            let pos = this._dtpSettings.get_string('dot-position');
            let highlightMargin = isWide ? this._dtpSettings.get_int('dot-size') : 0;

            if(!this.window) {
                let containerWidth = this._dtpIconContainer.get_width() / St.ThemeContext.get_for_stage(global.stage).scale_factor;
                let backgroundSize = containerWidth + "px " + 
                                     (containerWidth - (pos == DOT_POSITION.BOTTOM ? highlightMargin : 0)) + "px;";

                if (focusedDotStyle == DOT_STYLE.CILIORA || focusedDotStyle == DOT_STYLE.SEGMENTED)
                    highlightMargin += 1;

                if (this._nWindows > 1 && focusedDotStyle == DOT_STYLE.METRO) {
                    inlineStyle += "background-image: url('" + Me.path + "/img/highlight_stacked_bg.svg');" + 
                                   "background-position: 0 " + (pos == DOT_POSITION.TOP ? highlightMargin : 0) + "px;" +
                                   "background-size: " + backgroundSize;
                }
            }

            let highlightColor = this._getFocusHighlightColor();
            inlineStyle += "background-color: " + cssHexTocssRgba(highlightColor, this._dtpSettings.get_int('focus-highlight-opacity') * 0.01);
        }
        
        if(this._dotsContainer.get_style() != inlineStyle) {
            if (!this._isGroupApps) {
                //when the apps are ungrouped, set the style synchronously so the icons don't jump around on taskbar redraw
                this._dotsContainer.set_style(inlineStyle);
            } else {
                //graphical glitches if i dont set this on a timeout
                Mainloop.timeout_add(0, Lang.bind(this, function() { this._dotsContainer.set_style(inlineStyle); }));
            }
        }
    },

    _checkIfFocusedApp: function() {
        return tracker.focus_app == this.app;
    },

    _checkIfMonitorHasFocus: function() {
        return global.display.focus_window && 
               (!this._dtpSettings.get_boolean('multi-monitors') || // only check same monitor index if multi window is enabled.
                !this._dtpSettings.get_boolean('isolate-monitors') || 
                global.display.focus_window.get_monitor() === this.panelWrapper.monitor.index);
    },

    _setAppIconPadding: function() {
        let padding = getIconPadding(this._dtpSettings);
        let margin = this._dtpSettings.get_int('appicon-margin');

        this.actor.set_style('padding: 0 ' + margin + 'px;');
        this._iconContainer.set_style('padding: ' + padding + 'px;');
    },

    popupMenu: function() {
        this._removeMenuTimeout();
        this.actor.fake_release();
        
        if (this._draggable) { 
            this._draggable.fakeRelease();
        }

        if (!this._menu) {
            this._menu = new taskbarSecondaryMenu(this, this._dtpSettings);
            this._menu.connect('activate-window', Lang.bind(this, function (menu, window) {
                this.activateWindow(window, this._dtpSettings);
            }));
            this._menu.connect('open-state-changed', Lang.bind(this, function (menu, isPoppedUp) {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            }));
            let id = Main.overview.connect('hiding', Lang.bind(this, function () { this._menu.close(); }));
            this._menu.actor.connect('destroy', function() {
                Main.overview.disconnect(id);
            });

            this._menuManager.addMenu(this._menu);
        }

        this.emit('menu-state-changed', true);

        this._previewMenu.close(true);

        this.actor.set_hover(true);
        this._menu.actor.add_style_class_name('dashtopanelSecondaryMenu');
        this._menu.popup();
        this._menuManager.ignoreRelease();
        this.emit('sync-tooltip');

        return false;
    },

    _onFocusAppChanged: function(windowTracker) {
        this._displayProperIndicator(true);
    },

    _onOverviewWindowDragEnd: function(windowTracker) {
         Mainloop.timeout_add(0, Lang.bind(this, function () {
             this._displayProperIndicator();
             return GLib.SOURCE_REMOVE;
         }));
    },

    _onSwitchWorkspace: function(windowTracker) {
        this._displayProperIndicator();
    },

    _displayProperIndicator: function (force) {
        let isFocused = this._isFocusedWindow();

        this._setIconStyle(isFocused);

        if(!this._isGroupApps) {
            if (this.window && (this._dtpSettings.get_boolean('group-apps-underline-unfocused') || isFocused)) {
                let dotPosition = this._dtpSettings.get_string('dot-position');
                
                this._focusedDots.y_align = dotPosition == DOT_POSITION.TOP ? Clutter.ActorAlign.START : Clutter.ActorAlign.END;
                this._focusedDots.background_color = this._getRunningIndicatorColor(isFocused);
                this._focusedDots.show();
            } else if (this._focusedDots.visible) {
                this._focusedDots.hide();
            }
        } else {
            let containerWidth = this._container.width;
            let focusedDotStyle = this._dtpSettings.get_string('dot-style-focused');
            let unfocusedDotStyle = this._dtpSettings.get_string('dot-style-unfocused');
            let focusedIsWide = this._isWideDotStyle(focusedDotStyle);
            let unfocusedIsWide = this._isWideDotStyle(unfocusedDotStyle);
    
            let newFocusedDotsWidth = 0;
            let newFocusedDotsOpacity = 0;
            let newUnfocusedDotsWidth = 0;
            let newUnfocusedDotsOpacity = 0;
            
            isFocused = this._checkIfFocusedApp() && this._checkIfMonitorHasFocus();

            Mainloop.timeout_add(0, () => {
                if (!this._destroyed) {
                    if(isFocused) 
                        this.actor.add_style_class_name('focused');
                    else
                        this.actor.remove_style_class_name('focused');
                }
            });
            
            if(focusedIsWide) {
                newFocusedDotsWidth = (isFocused && this._nWindows > 0) ? containerWidth : 0;
                newFocusedDotsOpacity = 255;
            } else {
                newFocusedDotsWidth = containerWidth;
                newFocusedDotsOpacity = (isFocused && this._nWindows > 0) ? 255 : 0;
            }
    
            if(unfocusedIsWide) {
                newUnfocusedDotsWidth = (!isFocused && this._nWindows > 0) ? containerWidth : 0;
                newUnfocusedDotsOpacity = 255;
            } else {
                newUnfocusedDotsWidth = containerWidth;
                newUnfocusedDotsOpacity = (!isFocused && this._nWindows > 0) ? 255 : 0;
            }
    
            // Only animate if...
            // animation is enabled in settings
            // AND (going from a wide style to a narrow style indicator or vice-versa
            // OR going from an open app to a closed app or vice versa)
            if(this._dtpSettings.get_boolean('animate-app-switch') &&
               ((focusedIsWide != unfocusedIsWide) ||
                (this._focusedDots.width != newUnfocusedDotsWidth || this._unfocusedDots.width != newFocusedDotsWidth))) {
                this._animateDotDisplay(this._focusedDots, newFocusedDotsWidth, this._unfocusedDots, newUnfocusedDotsOpacity, force);
                this._animateDotDisplay(this._unfocusedDots, newUnfocusedDotsWidth, this._focusedDots, newFocusedDotsOpacity, force);
            } else {
                this._focusedDots.opacity = newFocusedDotsOpacity;
                this._unfocusedDots.opacity = newUnfocusedDotsOpacity;
                this._focusedDots.width = newFocusedDotsWidth;
                this._unfocusedDots.width = newUnfocusedDotsWidth;
            }
        }
    },

    _animateDotDisplay: function (dots, newWidth, otherDots, newOtherOpacity, force) {
        if((dots.width != newWidth && dots._tweeningToWidth !== newWidth) || force) {
                dots._tweeningToWidth = newWidth;
                Tweener.addTween(dots,
                                { width: newWidth,
                                time: DASH_ANIMATION_TIME,
                                transition: 'easeInOutCubic',
                                onStart: Lang.bind(this, function() { 
                                    if(newOtherOpacity == 0)
                                        otherDots.opacity = newOtherOpacity;
                                }),
                                onComplete: Lang.bind(this, function() { 
                                    if(newOtherOpacity > 0)
                                        otherDots.opacity = newOtherOpacity;
                                    dots._tweeningToWidth = null;
                                })
                            });
            }
    },

    _isFocusedWindow: function() {
        let focusedWindow = global.display.focus_window;
        
        while (focusedWindow) {
            if (focusedWindow == this.window) {
                return true;
            }

            focusedWindow = focusedWindow.get_transient_for();
        }

        return false;
    },

    _isWideDotStyle: function(dotStyle) {
        return dotStyle == DOT_STYLE.SEGMENTED || 
            dotStyle == DOT_STYLE.CILIORA || 
            dotStyle == DOT_STYLE.METRO || 
            dotStyle == DOT_STYLE.SOLID;
    },

    _isThemeProvidingIndicator: function () {
        // This is an attempt to determine if the theme is providing their own
        // running indicator by way of a border image on the icon, for example in
        // the theme Ciliora
        return (this.icon.actor.get_stage() && 
                this.icon.actor.get_theme_node().get_border_image());
    },

    activate: function(button, handleAsGrouped) {
        let event = Clutter.get_current_event();
        let modifiers = event ? event.get_state() : 0;

        // Only consider SHIFT and CONTROL as modifiers (exclude SUPER, CAPS-LOCK, etc.)
        modifiers = modifiers & (Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK);

        // We don't change the CTRL-click behaviour: in such case we just chain
        // up the parent method and return.
        if (modifiers & Clutter.ModifierType.CONTROL_MASK) {
                // Keep default behaviour: launch new window
                // By calling the parent method I make it compatible
                // with other extensions tweaking ctrl + click
                this.callParent('activate', button);
                return;
        }

        // We check what type of click we have and if the modifier SHIFT is
        // being used. We then define what buttonAction should be for this
        // event.
        let buttonAction = 0;
        if (button && button == 2 ) {
            if (modifiers & Clutter.ModifierType.SHIFT_MASK)
                buttonAction = this._dtpSettings.get_string('shift-middle-click-action');
            else
                buttonAction = this._dtpSettings.get_string('middle-click-action');
        }
        else if (button && button == 1) {
            if (modifiers & Clutter.ModifierType.SHIFT_MASK)
                buttonAction = this._dtpSettings.get_string('shift-click-action');
            else
                buttonAction = this._dtpSettings.get_string('click-action');
        }

        let appCount = this.getAppIconInterestingWindows().length;
        if (!(buttonAction == "TOGGLE-SHOWPREVIEW") || (appCount <= 1))
            this._previewMenu.close(true);

        // We check if the app is running, and that the # of windows is > 0 in
        // case we use workspace isolation,
        let appIsRunning = this.app.state == Shell.AppState.RUNNING && appCount > 0;

        // We customize the action only when the application is already running
        if (appIsRunning && !this.isLauncher) {
            if (this.window && !handleAsGrouped) {
                //ungrouped applications behaviors
                switch (buttonAction) {
                    case 'RAISE': case 'CYCLE': case 'CYCLE-MIN': case 'MINIMIZE': case 'TOGGLE-SHOWPREVIEW':
                        if (!Main.overview._shown && 
                            (buttonAction == 'MINIMIZE' || buttonAction == 'TOGGLE-SHOWPREVIEW' || buttonAction == 'CYCLE-MIN') && 
                            (this._isFocusedWindow() || (buttonAction == 'MINIMIZE' && (button == 2 || modifiers & Clutter.ModifierType.SHIFT_MASK)))) {
                                this.window.minimize();
                        } else {
                            Main.activateWindow(this.window);
                        }
                        
                        break;
        
                    case "LAUNCH":
                        this._launchNewInstance();
                        break;

                    case "QUIT":
                        this.window.delete(global.get_current_time());
                        break; 
                }
            } else {
                //grouped application behaviors
                let monitor = this.panelWrapper.monitor;
                let appHasFocus = this._checkIfFocusedApp() && this._checkIfMonitorHasFocus();

                switch (buttonAction) {
                    case "RAISE":
                        activateAllWindows(this.app, this._dtpSettings, monitor);
                        break;
        
                    case "LAUNCH":
                        this._launchNewInstance();
                        break;
        
                    case "MINIMIZE":
                        // In overview just activate the app, unless the acion is explicitely
                        // requested with a keyboard modifier
                        if (!Main.overview._shown || modifiers){
                            // If we have button=2 or a modifier, allow minimization even if
                            // the app is not focused
                            if (appHasFocus || button == 2 || modifiers & Clutter.ModifierType.SHIFT_MASK) {
                                // minimize all windows on double click and always in the case of primary click without
                                // additional modifiers
                                let click_count = 0;
                                if (Clutter.EventType.CLUTTER_BUTTON_PRESS)
                                    click_count = event.get_click_count();
                                let all_windows = (button == 1 && ! modifiers) || click_count > 1;
                                minimizeWindow(this.app, all_windows, this._dtpSettings, monitor);
                            }
                            else
                                activateAllWindows(this.app, this._dtpSettings, monitor);
                        }
                        else
                            this.app.activate();
                        break;
        
                    case "CYCLE":
                        if (!Main.overview._shown){
                            if (appHasFocus) 
                                cycleThroughWindows(this.app, this._dtpSettings, false, false, monitor);
                            else {
                                activateFirstWindow(this.app, this._dtpSettings, monitor);
                            }
                        }
                        else
                            this.app.activate();
                        break;
                    case "CYCLE-MIN":
                        if (!Main.overview._shown){
                            if (appHasFocus || (recentlyClickedApp == this.app && recentlyClickedAppWindows[recentlyClickedAppIndex % recentlyClickedAppWindows.length] == "MINIMIZE")) 
                                cycleThroughWindows(this.app, this._dtpSettings, false, true, monitor);
                            else {
                                activateFirstWindow(this.app, this._dtpSettings, monitor);
                            }
                        }
                        else
                            this.app.activate();
                        break;
                    case "TOGGLE-SHOWPREVIEW":
                        if (!Main.overview._shown) {
                            if (appCount == 1) {
                                if (appHasFocus)
                                    minimizeWindow(this.app, false, this._dtpSettings, monitor);
                                else
                                    activateFirstWindow(this.app, this._dtpSettings, monitor);
                            } else {
                                // minimize all windows if double clicked
                                if (Clutter.EventType.CLUTTER_BUTTON_PRESS) {
                                    let click_count = event.get_click_count();
                                    if(click_count > 1) {
                                        minimizeWindow(this.app, true, this._dtpSettings, monitor);
                                    }
                                } else {
                                    // Open the preview window
                                    this._previewMenu.requestOpen(this);
                                }
                            }
                        }
                        else
                            this.app.activate();
                        break;
        
                    case "QUIT":
                        closeAllWindows(this.app, this._dtpSettings, monitor);
                        break;
                }
            }
        }
        else {
            this._launchNewInstance();
        }

        Main.overview.hide();
    },

    _launchNewInstance: function() {
        if (this.app.can_open_new_window()) {
            let appActions = this.app.get_app_info().list_actions();
            let newWindowIndex = appActions.indexOf('new-window');

            if(this._dtpSettings.get_boolean('animate-window-launch')) {
                this.animateLaunch();
            }

            if (newWindowIndex < 0) {
                this.app.open_new_window(-1);
            } else {
                this.app.launch_action(appActions[newWindowIndex], global.get_current_time(), -1);
            }
        } else {
            let windows = this.window ? [this.window] : this.app.get_windows();

            if (windows.length) {
                Main.activateWindow(windows[0]);
            } else {
                this.app.activate();
            }
        }
    },

    _updateWindows: function() {
        let windows = [this.window];
        
        if (!this.window) {
            windows = this.getAppIconInterestingWindows();
        
            this._nWindows = windows.length;
    
            for (let i = 1; i <= MAX_INDICATORS; i++){
                let className = 'running'+i;
                if(i != this._nWindows)
                    this.actor.remove_style_class_name(className);
                else
                    this.actor.add_style_class_name(className);
            }
        }

        this._previewMenu.update(this, windows);
    },

    _getRunningIndicatorCount: function() {
        return Math.min(this._nWindows, MAX_INDICATORS);
    },

    _getRunningIndicatorHeight: function() {
        return this._dtpSettings.get_int('dot-size') * St.ThemeContext.get_for_stage(global.stage).scale_factor;
    },

    _getRunningIndicatorColor: function(isFocused) {
        let color;
        const fallbackColor = new Clutter.Color({ red: 82, green: 148, blue: 226, alpha: 255 });

        if (this._dtpSettings.get_boolean('dot-color-dominant')) {
            let dce = new Utils.DominantColorExtractor(this.app);
            let palette = dce._getColorPalette();
            if (palette) {
                color = Clutter.color_from_string(palette.original)[1];
            } else { // unable to determine color, fall back to theme
                let themeNode = this._dot.get_theme_node();
                color = themeNode.get_background_color();

                // theme didn't provide one, use a default
                if(color.alpha == 0) color = fallbackColor;
            }
        } else if(this._dtpSettings.get_boolean('dot-color-override')) {
            let dotColorSettingPrefix = 'dot-color-';
            
            if(!isFocused && this._dtpSettings.get_boolean('dot-color-unfocused-different'))
                dotColorSettingPrefix = 'dot-color-unfocused-';

            color = Clutter.color_from_string(this._dtpSettings.get_string(dotColorSettingPrefix + (this._getRunningIndicatorCount() || 1) ))[1];
        } else {
            // Re-use the style - background color, and border width and color -
            // of the default dot
            let themeNode = this._dot.get_theme_node();
            color = themeNode.get_background_color();

            // theme didn't provide one, use a default
            if(color.alpha == 0) color = fallbackColor;
        }

        return color;
    },

    _getFocusHighlightColor: function() {
        if (this._dtpSettings.get_boolean('focus-highlight-dominant')) {
            let dce = new Utils.DominantColorExtractor(this.app);
            let palette = dce._getColorPalette();
            if (palette) return palette.original;
        }
        return this._dtpSettings.get_string('focus-highlight-color');
    },

    _drawRunningIndicator: function(area, type, isFocused) {
        let n = this._getRunningIndicatorCount();

        if (!n) {
            return;
        }

        let bodyColor = this._getRunningIndicatorColor(isFocused);
        let [width, height] = area.get_surface_size();
        let cr = area.get_context();
        let size = this._getRunningIndicatorHeight();
        let padding = 0; // distance from the margin
        let yOffset = this._dtpSettings.get_string('dot-position') == DOT_POSITION.TOP ? 0 : (height - padding -  size);

        if(type == DOT_STYLE.DOTS) {
            // Draw the required numbers of dots
            let radius = size/2;
            let spacing = Math.ceil(width/18); // separation between the dots
        
            cr.translate((width - (2*n)*radius - (n-1)*spacing)/2, yOffset);

            Clutter.cairo_set_source_color(cr, bodyColor);
            for (let i = 0; i < n; i++) {
                cr.newSubPath();
                cr.arc((2*i+1)*radius + i*spacing, radius, radius, 0, 2*Math.PI);
            }
            cr.fill();
        } else if(type == DOT_STYLE.SQUARES) {
            let spacing = Math.ceil(width/18); // separation between the dots
        
            cr.translate(Math.floor((width - n*size - (n-1)*spacing)/2), yOffset);

            Clutter.cairo_set_source_color(cr, bodyColor);
            for (let i = 0; i < n; i++) {
                cr.newSubPath();
                cr.rectangle(i*size + i*spacing, 0, size, size);
            }
            cr.fill();
        } else if(type == DOT_STYLE.DASHES) {
            let spacing = Math.ceil(width/18); // separation between the dots
            let dashLength = Math.floor(width/4) - spacing;
        
            cr.translate(Math.floor((width - n*dashLength - (n-1)*spacing)/2), yOffset);

            Clutter.cairo_set_source_color(cr, bodyColor);
            for (let i = 0; i < n; i++) {
                cr.newSubPath();
                cr.rectangle(i*dashLength + i*spacing, 0, dashLength, size);
            }
            cr.fill();
        } else if(type == DOT_STYLE.SEGMENTED) {
            let spacing = Math.ceil(width/18); // separation between the dots
            let dashLength = Math.ceil((width - ((n-1)*spacing))/n);
        
            cr.translate(0, yOffset);

            Clutter.cairo_set_source_color(cr, bodyColor);
            for (let i = 0; i < n; i++) {
                cr.newSubPath();
                cr.rectangle(i*dashLength + i*spacing, 0, dashLength, size);
            }
            cr.fill();
        } else if (type == DOT_STYLE.CILIORA) {
            let spacing = size; // separation between the dots
            let lineLength = width - (size*(n-1)) - (spacing*(n-1));
        
            cr.translate(0, yOffset);

            Clutter.cairo_set_source_color(cr, bodyColor);
            cr.newSubPath();
            cr.rectangle(0, 0, lineLength, size);
            for (let i = 1; i < n; i++) {
                cr.newSubPath();
                cr.rectangle(lineLength + (i*spacing) + ((i-1)*size), 0, size, size);
            }
            cr.fill();
        } else if (type == DOT_STYLE.METRO) {
            if(n <= 1) {
                cr.translate(0, yOffset);
                Clutter.cairo_set_source_color(cr, bodyColor);
                cr.newSubPath();
                cr.rectangle(0, 0, width, size);
                cr.fill();
            } else {
                let blackenedLength = (1/48)*width; // need to scale with the SVG for the stacked highlight
                let darkenedLength = isFocused ? (2/48)*width : (10/48)*width;
                let blackenedColor = bodyColor.shade(.3);
                let darkenedColor = bodyColor.shade(.7);

                cr.translate(0, yOffset);

                Clutter.cairo_set_source_color(cr, bodyColor);
                cr.newSubPath();
                cr.rectangle(0, 0, width - darkenedLength - blackenedLength, size);
                cr.fill();
                Clutter.cairo_set_source_color(cr, blackenedColor);
                cr.newSubPath();
                cr.rectangle(width - darkenedLength - blackenedLength, 0, 1, size);
                cr.fill();
                Clutter.cairo_set_source_color(cr, darkenedColor);
                cr.newSubPath();
                cr.rectangle(width - darkenedLength, 0, darkenedLength, size);
                cr.fill();
            }
        } else { // solid
            cr.translate(0, yOffset);
            Clutter.cairo_set_source_color(cr, bodyColor);
            cr.newSubPath();
            cr.rectangle(0, 0, width, size);
            cr.fill();
        }
        
        cr.$dispose();
    },

    _numberOverlay: function() {
        // Add label for a Hot-Key visual aid
        this._numberOverlayLabel = new St.Label();
        this._numberOverlayBin = new St.Bin({
            child: this._numberOverlayLabel,
            x_align: St.Align.START, y_align: St.Align.START,
            x_expand: true, y_expand: true
        });
        this._numberOverlayLabel.add_style_class_name('number-overlay');
        this._numberOverlayOrder = -1;
        this._numberOverlayBin.hide();

        this._iconContainer.add_child(this._numberOverlayBin);

    },

    updateNumberOverlay: function() {
        // We apply an overall scale factor that might come from a HiDPI monitor.
        // Clutter dimensions are in physical pixels, but CSS measures are in logical
        // pixels, so make sure to consider the scale.
        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // Set the font size to something smaller than the whole icon so it is
        // still visible. The border radius is large to make the shape circular
        let [minWidth, natWidth] = this._iconContainer.get_preferred_width(-1);
        let font_size =  Math.round(Math.max(12, 0.3*natWidth) / scaleFactor);
        let size = Math.round(font_size*1.2);
        this._numberOverlayLabel.set_style(
           'font-size: ' + font_size + 'px;' +
           'border-radius: ' + this.icon.iconSize + 'px;' +
           'width: ' + size + 'px; height: ' + size +'px;'
        );
    },

    setNumberOverlay: function(number) {
        this._numberOverlayOrder = number;
        this._numberOverlayLabel.set_text(number.toString());
    },

    toggleNumberOverlay: function(activate) {
        if (activate && this._numberOverlayOrder > -1)
           this._numberOverlayBin.show();
        else
           this._numberOverlayBin.hide();
    },

    handleDragOver: function(source, actor, x, y, time) {
        if (source == Main.xdndHandler) {
            this._previewMenu.close(true);
        }
            
        return DND.DragMotionResult.CONTINUE;
    },

    getAppIconInterestingWindows: function(isolateMonitors) {
        return getInterestingWindows(this.app, this._dtpSettings, this.panelWrapper.monitor, isolateMonitors);
    }

});

function minimizeWindow(app, param, settings, monitor){
    // Param true make all app windows minimize
    let windows = getInterestingWindows(app, settings, monitor);
    let current_workspace = Utils.DisplayWrapper.getWorkspaceManager().get_active_workspace();
    for (let i = 0; i < windows.length; i++) {
        let w = windows[i];
        if (w.get_workspace() == current_workspace && w.showing_on_its_workspace()){
            w.minimize();
            // Just minimize one window. By specification it should be the
            // focused window on the current workspace.
            if(!param)
                break;
        }
    }
}

/*
 * By default only non minimized windows are activated.
 * This activates all windows in the current workspace.
 */
function activateAllWindows(app, settings, monitor){

    // First activate first window so workspace is switched if needed,
    // then activate all other app windows in the current workspace.
    let windows = getInterestingWindows(app, settings, monitor);
    let w = windows[0];
    Main.activateWindow(w);
    let activeWorkspace = Utils.DisplayWrapper.getWorkspaceManager().get_active_workspace_index();

    if (windows.length <= 0)
        return;

    for (let i = windows.length - 1; i >= 0; i--){
        if (windows[i].get_workspace().index() == activeWorkspace){
            Main.activateWindow(windows[i]);
        }
    }
}

function activateFirstWindow(app, settings, monitor){

    let windows = getInterestingWindows(app, settings, monitor);
    Main.activateWindow(windows[0]);
}

function cycleThroughWindows(app, settings, reversed, shouldMinimize, monitor) {
    // Store for a little amount of time last clicked app and its windows
    // since the order changes upon window interaction
    let MEMORY_TIME=3000;

    let app_windows = getInterestingWindows(app, settings, monitor);

    if(shouldMinimize)
        app_windows.push("MINIMIZE");

    if (recentlyClickedAppLoopId > 0)
        Mainloop.source_remove(recentlyClickedAppLoopId);
    recentlyClickedAppLoopId = Mainloop.timeout_add(MEMORY_TIME, resetRecentlyClickedApp);

    // If there isn't already a list of windows for the current app,
    // or the stored list is outdated, use the current windows list.
    if (!recentlyClickedApp ||
        recentlyClickedApp.get_id() != app.get_id() ||
        recentlyClickedAppWindows.length != app_windows.length ||
        recentlyClickedAppMonitorIndex != monitor.index) {
        recentlyClickedApp = app;
        recentlyClickedAppWindows = app_windows;
        recentlyClickedAppIndex = 0;
        recentlyClickedAppMonitorIndex = monitor.index;
    }

    if (reversed) {
        recentlyClickedAppIndex--;
        if (recentlyClickedAppIndex < 0) recentlyClickedAppIndex = recentlyClickedAppWindows.length - 1;
    } else {
        recentlyClickedAppIndex++;
    }
    let index = recentlyClickedAppIndex % recentlyClickedAppWindows.length;
    
    if(recentlyClickedAppWindows[index] === "MINIMIZE")
        minimizeWindow(app, true, settings, monitor);
    else
        Main.activateWindow(recentlyClickedAppWindows[index]);
}

function resetRecentlyClickedApp() {
    if (recentlyClickedAppLoopId > 0)
        Mainloop.source_remove(recentlyClickedAppLoopId);
    recentlyClickedAppLoopId=0;
    recentlyClickedApp =null;
    recentlyClickedAppWindows = null;
    recentlyClickedAppIndex = 0;
    recentlyClickedAppMonitorIndex = null;

    return false;
}

function closeAllWindows(app, settings, monitor) {
    let windows = getInterestingWindows(app, settings, monitor);
    for (let i = 0; i < windows.length; i++)
        windows[i].delete(global.get_current_time());
}

// Filter out unnecessary windows, for instance
// nautilus desktop window.
function getInterestingWindows(app, settings, monitor, isolateMonitors) {
    let windows = app.get_windows().filter(function(w) {
        return !w.skip_taskbar;
    });

    // When using workspace or monitor isolation, we filter out windows
    // that are not in the current workspace or on the same monitor as the appicon
    if (settings.get_boolean('isolate-workspaces'))
        windows = windows.filter(function(w) {
            return w.get_workspace().index() == Utils.DisplayWrapper.getWorkspaceManager().get_active_workspace_index();
        });

    if (monitor && settings.get_boolean('multi-monitors') && (isolateMonitors || settings.get_boolean('isolate-monitors'))) {
        windows = windows.filter(function(w) {
            return w.get_monitor() == monitor.index;
        });
    }
    
    return windows;
}

function cssHexTocssRgba(cssHex, opacity) {
    var bigint = parseInt(cssHex.slice(1), 16);
    var r = (bigint >> 16) & 255;
    var g = (bigint >> 8) & 255;
    var b = bigint & 255;

    return 'rgba(' + [r, g, b].join(',') + ',' + opacity + ')';
}

function getIconPadding(dtpSettings) {
    let panelSize = dtpSettings.get_int('panel-size');
    let padding = dtpSettings.get_int('appicon-padding');
    let availSize = panelSize - Taskbar.MIN_ICON_SIZE - panelSize % 2;

    if (padding * 2 > availSize) {
        padding = availSize * .5;
    }

    return padding;
}

/**
 * Extend AppIconMenu
 *
 * - set popup arrow side based on taskbar orientation
 * - Add close windows option based on quitfromdash extension
 *   (https://github.com/deuill/shell-extension-quitfromdash)
 */

var taskbarSecondaryMenu = Utils.defineClass({
    Name: 'DashToPanel.SecondaryMenu',
    Extends: AppDisplay.AppIconMenu,
    ParentConstrParams: [[0]],

    _init: function(source, settings) {
        this._dtpSettings = settings;

        // Damm it, there has to be a proper way of doing this...
        // As I can't call the parent parent constructor (?) passing the side
        // parameter, I overwite what I need later
        this.callParent('_init', source);

        let side = Taskbar.getPosition();
        // Change the initialized side where required.
        this._arrowSide = side;
        this._boxPointer._arrowSide = side;
        this._boxPointer._userArrowSide = side;
    },

    // helper function for the quit windows abilities
    _closeWindowInstance: function(metaWindow) {
        metaWindow.delete(global.get_current_time());
    },

    _redisplay: function() {
        this.callParent('_redisplay');

        // Remove "Show Details" menu item
        if(!this._dtpSettings.get_boolean('secondarymenu-contains-showdetails')) {
            let existingMenuItems = this._getMenuItems();
            for(let idx in existingMenuItems) {
                if(existingMenuItems[idx].actor.label_actor.text == _("Show Details")) {
                    this.box.remove_child(existingMenuItems[idx].actor);
                    if(existingMenuItems[idx-1] instanceof PopupMenu.PopupSeparatorMenuItem)
                        this.box.remove_child(existingMenuItems[idx-1].actor);
                    break;
                }
            }
        }

        // prepend items from the appMenu (for native gnome apps)
        if(this._dtpSettings.get_boolean('secondarymenu-contains-appmenu')) {
            let appMenu = this._source.app.menu;
            if(appMenu) {
                let remoteMenu = new imports.ui.remoteMenu.RemoteMenu(this._source.actor, this._source.app.menu, this._source.app.action_group);
                let appMenuItems = remoteMenu._getMenuItems();
                let itemPosition = 0;
                for(let appMenuIdx in appMenuItems){
                    let menuItem = appMenuItems[appMenuIdx];
                    let labelText = menuItem.actor.label_actor.text;
                    if(labelText == _("New Window") || labelText == _("Quit"))
                        continue;
                    
                    if(menuItem instanceof PopupMenu.PopupSeparatorMenuItem)
                        continue;

                    // this ends up getting called multiple times, and bombing due to the signal id's being invalid
                    // on a 2nd pass. disconnect the base handler and attach our own that wraps the id's in if statements
                    menuItem.disconnect(menuItem._popupMenuDestroyId)
                    menuItem._popupMenuDestroyId = menuItem.connect('destroy', Lang.bind(this, function(menuItem) {
                        if(menuItem._popupMenuDestroyId) {
                            menuItem.disconnect(menuItem._popupMenuDestroyId);
                            menuItem._popupMenuDestroyId = 0;
                        }
                        if(menuItem._activateId) {
                            menuItem.disconnect(menuItem._activateId);
                            menuItem._activateId = 0;
                        }
                        if(menuItem._activeChangeId) {
                            menuItem.disconnect(menuItem._activeChangeId);
                            menuItem._activeChangeId = 0;
                        }
                        if(menuItem._sensitiveChangeId) {
                            menuItem.disconnect(menuItem._sensitiveChangeId);
                            menuItem._sensitiveChangeId = 0;
                        }
                        this.disconnect(menuItem._parentSensitiveChangeId);
                        if (menuItem == this._activeMenuItem)
                            this._activeMenuItem = null;
                    }));

                    menuItem.actor.get_parent().remove_child(menuItem.actor);
                    if(menuItem instanceof PopupMenu.PopupSubMenuMenuItem) {
                        let newSubMenuMenuItem = new PopupMenu.PopupSubMenuMenuItem(labelText);
                        let appSubMenuItems = menuItem.menu._getMenuItems();
                        for(let appSubMenuIdx in appSubMenuItems){
                            let subMenuItem = appSubMenuItems[appSubMenuIdx];
                            subMenuItem.actor.get_parent().remove_child(subMenuItem.actor);
                            newSubMenuMenuItem.menu.addMenuItem(subMenuItem);
                        }
                        this.addMenuItem(newSubMenuMenuItem, itemPosition);
                    } else 
                        this.addMenuItem(menuItem, itemPosition);

                    itemPosition++;
                }
                
                if(itemPosition > 0) {
                    let separator = new PopupMenu.PopupSeparatorMenuItem();
                    this.addMenuItem(separator, itemPosition);
                }
            }
        }

        // quit menu
        let app = this._source.app;
        let window = this._source.window;
        let count = window ? 1 : getInterestingWindows(app, this._dtpSettings).length;
        if ( count > 0) {
            this._appendSeparator();
            let quitFromTaskbarMenuText = "";
            if (count == 1)
                quitFromTaskbarMenuText = _("Quit");
            else
                quitFromTaskbarMenuText = _("Quit") + ' ' + count + ' ' + _("Windows");

            this._quitfromTaskbarMenuItem = this._appendMenuItem(quitFromTaskbarMenuText);
            this._quitfromTaskbarMenuItem.connect('activate', Lang.bind(this, function() {
                let app = this._source.app;
                let windows = window ? [window] : app.get_windows();
                for (let i = 0; i < windows.length; i++) {
                    this._closeWindowInstance(windows[i])
                }
            }));
        }
    }
});
Signals.addSignalMethods(taskbarSecondaryMenu.prototype);

/**
 * This function is used for extendDashItemContainer
 */
function ItemShowLabel()  {
    if (!this._labelText)
        return;

    this.label.set_text(this._labelText);
    this.label.opacity = 0;
    this.label.show();

    let [stageX, stageY] = this.get_transformed_position();
    let node = this.label.get_theme_node();

    let itemWidth  = this.allocation.x2 - this.allocation.x1;
    let itemHeight = this.allocation.y2 - this.allocation.y1;

    let labelWidth = this.label.get_width();
    let labelHeight = this.label.get_height();

    let position = Taskbar.getPosition();
    let labelOffset = node.get_length('-x-offset');

    let xOffset = Math.floor((itemWidth - labelWidth) / 2);
    let x = stageX + xOffset, y;

    switch(position) {
      case St.Side.TOP:
          y = stageY + labelOffset + itemHeight;
          break;
      case St.Side.BOTTOM:
          y = stageY - labelHeight - labelOffset;
          break;
    }

    // keep the label inside the screen border
    // Only needed for the x coordinate.

    // Leave a few pixel gap
    let gap = LABEL_GAP;
    let monitor = Main.layoutManager.findMonitorForActor(this);
    if ( x - monitor.x < gap)
        x += monitor.x - x + labelOffset;
    else if ( x + labelWidth > monitor.x + monitor.width - gap)
        x -= x + labelWidth -( monitor.x + monitor.width) + gap;

    this.label.set_position(x, y);
    Tweener.addTween(this.label,
      { opacity: 255,
        time: DASH_ITEM_LABEL_SHOW_TIME,
        transition: 'easeOutQuad',
      });
};

/**
 * A wrapper class around the ShowAppsIcon class.
 *
 * - Pass settings to the constructor
 * - set label position based on dash orientation (Note, I am reusing most machinery of the appIcon class)
 * - implement a popupMenu based on the AppIcon code (Note, I am reusing most machinery of the appIcon class)
 *
 * I can't subclass the original object because of this: https://bugzilla.gnome.org/show_bug.cgi?id=688973.
 * thus use this pattern where the real showAppsIcon object is encaptulated, and a reference to it will be properly wired upon
 * use of this class in place of the original showAppsButton.
 *
 */
var ShowAppsIconWrapper = Utils.defineClass({
    Name: 'DashToPanel.ShowAppsIconWrapper',

    _init: function(settings) {
        this._dtpSettings = settings;
        this.realShowAppsIcon = new Dash.ShowAppsIcon();

        Utils.wrapActor(this.realShowAppsIcon);
        Utils.wrapActor(this.realShowAppsIcon.toggleButton);

        /* the variable equivalent to toggleButton has a different name in the appIcon class
        (actor): duplicate reference to easily reuse appIcon methods */
        this.actor = this.realShowAppsIcon.toggleButton;
        this.realShowAppsIcon.actor.y_align = Clutter.ActorAlign.START;

        // Re-use appIcon methods
        this._removeMenuTimeout = AppDisplay.AppIcon.prototype._removeMenuTimeout;
        this._setPopupTimeout = AppDisplay.AppIcon.prototype._setPopupTimeout;
        this._onButtonPress = AppDisplay.AppIcon.prototype._onButtonPress;
        this._onKeyboardPopupMenu = AppDisplay.AppIcon.prototype._onKeyboardPopupMenu;
        this._onLeaveEvent = AppDisplay.AppIcon.prototype._onLeaveEvent;
        this._onTouchEvent = AppDisplay.AppIcon.prototype._onTouchEvent;
        this._onMenuPoppedDown = AppDisplay.AppIcon.prototype._onMenuPoppedDown;

        // No action on clicked (showing of the appsview is controlled elsewhere)
        this._onClicked = Lang.bind(this, function(actor, button) {
            this._removeMenuTimeout();
        });

        this.actor.connect('leave-event', Lang.bind(this, this._onLeaveEvent));
        this.actor.connect('button-press-event', Lang.bind(this, this._onButtonPress));
        this.actor.connect('touch-event', Lang.bind(this, this._onTouchEvent));
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
        this.actor.connect('popup-menu', Lang.bind(this, this._onKeyboardPopupMenu));

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);
        this._menuTimeoutId = 0;

        this.realShowAppsIcon.showLabel = ItemShowLabel;

        let customIconPath = this._dtpSettings.get_string('show-apps-icon-file');

        this.realShowAppsIcon.icon.createIcon = function(size) {
            this._iconActor = new St.Icon({ icon_name: 'view' + (Config.PACKAGE_VERSION < '3.20' ? '' : '-app') + '-grid-symbolic',
                                            icon_size: size,
                                            style_class: 'show-apps-icon',
                                            track_hover: true });

            if (customIconPath) {
                this._iconActor.gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(customIconPath) });
            }
            
            return this._iconActor;
        };

        this._changedShowAppsIconId = this._dtpSettings.connect('changed::show-apps-icon-file', () => {
            customIconPath = this._dtpSettings.get_string('show-apps-icon-file');
            this.realShowAppsIcon.icon._createIconTexture(this.realShowAppsIcon.icon.iconSize);
        });

        this._changedAppIconPaddingId = this._dtpSettings.connect('changed::appicon-padding', () => this.setShowAppsPadding());
        this._changedAppIconSidePaddingId = this._dtpSettings.connect('changed::show-apps-icon-side-padding', () => this.setShowAppsPadding());
        
        this.setShowAppsPadding();
    },

    setShowAppsPadding: function() {
        let padding = getIconPadding(this._dtpSettings); 
        let sidePadding = this._dtpSettings.get_int('show-apps-icon-side-padding')

        this.actor.set_style('padding:' + padding + 'px ' + (padding + sidePadding) + 'px;');
    },

    popupMenu: function() {
        this._removeMenuTimeout();
        this.actor.fake_release();
        
        if (!this._menu) {
            this._menu = new MyShowAppsIconMenu(this, this._dtpSettings);
            this._menu.connect('open-state-changed', Lang.bind(this, function(menu, isPoppedUp) {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            }));
            let id = Main.overview.connect('hiding', Lang.bind(this, function() {
                this._menu.close();
            }));
            this._menu.actor.connect('destroy', function() {
                Main.overview.disconnect(id);
            });
            this._menuManager.addMenu(this._menu);
        }

        //this.emit('menu-state-changed', true);

        this.actor.set_hover(true);
        this._menu.popup();
        this._menuManager.ignoreRelease();
        this.emit('sync-tooltip');

        return false;
    },

    shouldShowTooltip: function() {
        return this._dtpSettings.get_boolean('show-tooltip') && 
               (this.actor.hover && (!this._menu || !this._menu.isOpen));
    },

    destroy: function() {
        this._dtpSettings.disconnect(this._changedShowAppsIconId);
        this._dtpSettings.disconnect(this._changedAppIconSidePaddingId);
        this._dtpSettings.disconnect(this._changedAppIconPaddingId);
    }
});
Signals.addSignalMethods(ShowAppsIconWrapper.prototype);

/**
 * A menu for the showAppsIcon
 */
var MyShowAppsIconMenu = Utils.defineClass({
    Name: 'DashToPanel.ShowAppsIconMenu',
    Extends: taskbarSecondaryMenu,
    ParentConstrParams: [[0]],

    _redisplay: function() {
        this.removeAll();

        let powerSettingsMenuItem = this._appendMenuItem(_('Power options'));
        powerSettingsMenuItem.connect('activate', function () {
            Util.spawn(['gnome-control-center', 'power']);
        });

        let logsMenuItem = this._appendMenuItem(_('Event logs'));
        logsMenuItem.connect('activate', function () {
            Util.spawn(['gnome-logs']);
        });

        let systemSettingsMenuItem = this._appendMenuItem(_('System'));
        systemSettingsMenuItem.connect('activate', function () {
            Util.spawn(['gnome-control-center', 'info-overview']);
        });

        let devicesSettingsMenuItem = this._appendMenuItem(_('Device Management'));
        devicesSettingsMenuItem.connect('activate', function () {
            Util.spawn(['gnome-control-center', 'display']);
        });

        let disksMenuItem = this._appendMenuItem(_('Disk Management'));
        disksMenuItem.connect('activate', function () {
            Util.spawn(['gnome-disks']);
        });

        this._appendSeparator();

        let terminalMenuItem = this._appendMenuItem(_('Terminal'));
        terminalMenuItem.connect('activate', function () {
            Util.spawn(['gnome-terminal']);
        });

        let systemMonitorMenuItem = this._appendMenuItem(_('System monitor'));
        systemMonitorMenuItem.connect('activate', function () {
            Util.spawn(['gnome-system-monitor']);
        });

        let filesMenuItem = this._appendMenuItem(_('Files'));
        filesMenuItem.connect('activate', function () {
            Util.spawn(['nautilus']);
        });

        let gsSettingsMenuItem = this._appendMenuItem(_('Settings'));
        gsSettingsMenuItem.connect('activate', function () {
            Util.spawn(['gnome-control-center', 'wifi']);
        });     

        this._appendSeparator();

        let lockTaskbarMenuItem = this._appendMenuItem(this._dtpSettings.get_boolean('taskbar-locked') ? _('Unlock taskbar') : _('Lock taskbar'));
        lockTaskbarMenuItem.connect('activate', () => {
            this._dtpSettings.set_boolean('taskbar-locked', !this._dtpSettings.get_boolean('taskbar-locked'));
        });

        let settingsMenuItem = this._appendMenuItem(_('Dash to Panel Settings'));
        settingsMenuItem.connect('activate', function () {
            Util.spawn(["gnome-shell-extension-prefs", Me.metadata.uuid]);
        });

        if(this._source._dtpPanel) {
            this._appendSeparator();
            let item = this._appendMenuItem(this._source._dtpPanel._restoreWindowList ? _('Restore Windows') : _('Show Desktop'));
            item.connect('activate', Lang.bind(this._source._dtpPanel, this._source._dtpPanel._onShowDesktopButtonPress));
        }
    }
});
