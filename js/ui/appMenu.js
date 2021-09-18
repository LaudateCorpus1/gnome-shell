// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported AppMenu */
const { Clutter, Gio, GLib, Meta, Shell, St } = imports.gi;

import * as AppFavorites from './appFavorites.js';
import Main from './main.js';
import * as ParentalControlsManager from '../misc/parentalControlsManager.js';
import * as PopupMenu from './popupMenu.js';

export class AppMenu extends PopupMenu.PopupMenu {
    /**
     * @param {Clutter.Actor} sourceActor - actor the menu is attached to
     * @param {St.Side} side - arrow side
     * @param {object} params - options
     * @param {bool} params.favoritesSection - show items to add/remove favorite
     * @param {bool} params.showSingleWindow - show window section for a single window
     */
    constructor(sourceActor, side = St.Side.TOP, params = {}) {
        if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL) {
            if (side === St.Side.LEFT)
                side = St.Side.RIGHT;
            else if (side === St.Side.RIGHT)
                side = St.Side.LEFT;
        }

        super(sourceActor, 0.5, side);

        this.actor.add_style_class_name('app-menu');

        const {
            favoritesSection = false,
            showSingleWindows = false,
        } = params;

        this._app = null;
        this._appSystem = Shell.AppSystem.get_default();
        this._parentalControlsManager = ParentalControlsManager.getDefault();
        this._appFavorites = AppFavorites.getAppFavorites();
        this._enableFavorites = favoritesSection;
        this._showSingleWindows = showSingleWindows;

        this._windowsChangedId = 0;
        this._updateWindowsLaterId = 0;

        /* Translators: This is the heading of a list of open windows */
        this._openWindowsHeader = new PopupMenu.PopupSeparatorMenuItem(_('Open Windows'));
        this.addMenuItem(this._openWindowsHeader);

        this._windowSection = new PopupMenu.PopupMenuSection();
        this.addMenuItem(this._windowSection);

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._newWindowItem = this.addAction(_('New Window'), () => {
            this._animateLaunch();
            this._app.open_new_window(-1);
            Main.overview.hide();
        });

        this._actionSection = new PopupMenu.PopupMenuSection();
        this.addMenuItem(this._actionSection);

        this._onGpuMenuItem = this.addAction('', () => {
            this._animateLaunch();
            this._app.launch(0, -1, this._getNonDefaultLaunchGpu());
            Main.overview.hide();
        });

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._toggleFavoriteItem = this.addAction('', () => {
            const appId = this._app.get_id();
            if (this._appFavorites.isFavorite(appId))
                this._appFavorites.removeFavorite(appId);
            else
                this._appFavorites.addFavorite(appId);
        });

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._detailsItem = this.addAction(_('Show Details'), async () => {
            const id = this._app.get_id();
            const args = GLib.Variant.new('(ss)', [id, '']);
            const bus = await Gio.DBus.get(Gio.BusType.SESSION, null);
            bus.call(
                'org.gnome.Software',
                '/org/gnome/Software',
                'org.gtk.Actions', 'Activate',
                new GLib.Variant('(sava{sv})', ['details', [args], null]),
                null, 0, -1, null);
        });

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._quitItem =
            this.addAction(_('Quit'), () => this._app.request_quit());

        this._signals = [];
        this._signals.push([
            this._appSystem,
            this._appSystem.connect('installed-changed',
                () => this._updateDetailsVisibility()),
        ], [
            this._appSystem,
            this._appSystem.connect('app-state-changed',
                this._onAppStateChanged.bind(this)),
        ], [
            this._parentalControlsManager,
            this._parentalControlsManager.connect('app-filter-changed',
                () => this._updateFavoriteItem()),
        ], [
            this._appFavorites,
            this._appFavorites.connect('changed',
                () => this._updateFavoriteItem()),
        ], [
            global.settings,
            global.settings.connect('writable-changed::favorite-apps',
                () => this._updateFavoriteItem()),
        ], [
            global,
            global.connect('notify::switcheroo-control',
                () => this._updateGpuItem()),
        ]);
        this._updateQuitItem();
        this._updateFavoriteItem();
        this._updateGpuItem();
        this._updateDetailsVisibility();
    }

    _onAppStateChanged(sys, app) {
        if (this._app !== app)
            return;

        this._updateQuitItem();
        this._updateNewWindowItem();
        this._updateGpuItem();
    }

    _updateQuitItem() {
        this._quitItem.visible = this._app?.state === Shell.AppState.RUNNING;
    }

    _updateNewWindowItem() {
        const actions = this._app?.appInfo?.list_actions() ?? [];
        this._newWindowItem.visible =
            this._app?.can_open_new_window() && !actions.includes('new-window');
    }

    _updateFavoriteItem() {
        const appInfo = this._app?.app_info;
        const canFavorite = appInfo &&
            this._enableFavorites &&
            global.settings.is_writable('favorite-apps') &&
            this._parentalControlsManager.shouldShowApp(appInfo);

        this._toggleFavoriteItem.visible = canFavorite;

        if (!canFavorite)
            return;

        const { id } = this._app;
        this._toggleFavoriteItem.label.text = this._appFavorites.isFavorite(id)
            ? _('Remove from Favorites')
            : _('Add to Favorites');
    }

    _updateGpuItem() {
        const proxy = global.get_switcheroo_control();
        const hasDualGpu = proxy?.get_cached_property('HasDualGpu')?.unpack();

        const showItem =
            this._app?.state === Shell.AppState.STOPPED && hasDualGpu;

        this._onGpuMenuItem.visible = showItem;

        if (!showItem)
            return;

        const launchGpu = this._getNonDefaultLaunchGpu();
        this._onGpuMenuItem.label.text = launchGpu === Shell.AppLaunchGpu.DEFAULT
            ? _('Launch using Integrated Graphics Card')
            : _('Launch using Discrete Graphics Card');
    }

    _updateDetailsVisibility() {
        const sw = this._appSystem.lookup_app('org.gnome.Software.desktop');
        this._detailsItem.visible = sw !== null;
    }

    _animateLaunch() {
        if (this.sourceActor.animateLaunch)
            this.sourceActor.animateLaunch();
    }

    _getNonDefaultLaunchGpu() {
        return this._app.appInfo.get_boolean('PrefersNonDefaultGPU')
            ? Shell.AppLaunchGpu.DEFAULT
            : Shell.AppLaunchGpu.DISCRETE;
    }

    /** */
    destroy() {
        super.destroy();

        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];

        this.setApp(null);
    }

    /**
     * @returns {bool} - true if the menu is empty
     */
    isEmpty() {
        if (!this._app)
            return true;
        return super.isEmpty();
    }

    /**
     * @param {Shell.App} app - the app the menu represents
     */
    setApp(app) {
        if (this._app === app)
            return;

        if (this._windowsChangedId)
            this._app.disconnect(this._windowsChangedId);
        this._windowsChangedId = 0;

        this._app = app;

        if (app) {
            this._windowsChangedId = app.connect('windows-changed',
                () => this._queueUpdateWindowsSection());
        }

        this._updateWindowsSection();

        const appInfo = app?.app_info;
        const actions = appInfo?.list_actions() ?? [];

        this._actionSection.removeAll();
        actions.forEach(action => {
            const label = appInfo.get_action_name(action);
            this._actionSection.addAction(label, event => {
                if (action === 'new-window')
                    this._animateLaunch();

                this._app.launch_action(action, event.get_time(), -1);
                Main.overview.hide();
            });
        });

        this._updateQuitItem();
        this._updateNewWindowItem();
        this._updateFavoriteItem();
        this._updateGpuItem();
    }

    _queueUpdateWindowsSection() {
        if (this._updateWindowsLaterId)
            return;

        this._updateWindowsLaterId = Meta.later_add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._updateWindowsSection();
                return GLib.SOURCE_REMOVE;
            });
    }

    _updateWindowsSection() {
        if (this._updateWindowsLaterId)
            Meta.later_remove(this._updateWindowsLaterId);
        this._updateWindowsLaterId = 0;

        this._windowSection.removeAll();
        this._openWindowsHeader.hide();

        if (!this._app)
            return;

        const minWindows = this._showSingleWindows ? 1 : 2;
        const windows = this._app.get_windows().filter(w => !w.skip_taskbar);
        if (windows.length < minWindows)
            return;

        this._openWindowsHeader.show();

        windows.forEach(window => {
            const title = window.title || this._app.get_name();
            const item = this._windowSection.addAction(title, event => {
                Main.activateWindow(window, event.get_time());
            });
            const id = window.connect('notify::title', () => {
                item.label.text = window.title || this._app.get_name();
            });
            item.connect('destroy', () => window.disconnect(id));
        });
    }
};
