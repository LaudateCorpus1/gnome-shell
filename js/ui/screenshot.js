// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported ScreenshotService, ScreenshotUI, showScreenshotUI */

const { Clutter, Gio, GObject, GLib, Meta, Shell, St } = imports.gi;

const GrabHelper = imports.ui.grabHelper;
const Layout = imports.ui.layout;
const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;

Gio._promisify(Shell.Screenshot.prototype, 'pick_color', 'pick_color_finish');
Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');
Gio._promisify(Shell.Screenshot.prototype,
    'screenshot_window', 'screenshot_window_finish');
Gio._promisify(Shell.Screenshot.prototype,
    'screenshot_area', 'screenshot_area_finish');
Gio._promisify(Shell.Screenshot.prototype,
    'screenshot_stage_to_content', 'screenshot_stage_to_content_finish');
Gio._promisify(
    Shell.Screenshot,
    'composite_to_stream', 'composite_to_stream_finish');

const { loadInterfaceXML } = imports.misc.fileUtils;
const { DBusSenderChecker } = imports.misc.util;

const ScreenshotIface = loadInterfaceXML('org.gnome.Shell.Screenshot');

var IconLabelButton = GObject.registerClass(
class IconLabelButton extends St.Button {
    _init(iconName, label, params) {
        super._init(params);

        this._container = new St.BoxLayout({
            vertical: true,
            style_class: 'icon-label-button-container',
        });
        this.set_child(this._container);

        this._container.add_child(new St.Icon({ icon_name: iconName }));
        this._container.add_child(new St.Label({
            text: label,
            x_align: Clutter.ActorAlign.CENTER,
        }));
    }
});

var ScreenshotUI = GObject.registerClass(
class ScreenshotUI extends St.Widget {
    _init() {
        super._init({
            name: 'screenshot-ui',
            constraints: new Clutter.BindConstraint({
                source: global.stage,
                coordinate: Clutter.BindCoordinate.ALL,
            }),
            layout_manager: new Clutter.BinLayout(),
            opacity: 0,
            visible: false,
        });

        // The full-screen screenshot has a separate container so that we can
        // show it without the screenshot UI fade-in for a nicer animation.
        this._stageScreenshotContainer = new St.Widget({ visible: false });
        this._stageScreenshotContainer.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        Main.layoutManager.screenshotUIGroup.add_child(
            this._stageScreenshotContainer);

        Main.layoutManager.screenshotUIGroup.add_child(this);

        this._stageScreenshot = new St.Widget({ style_class: 'screenshot-ui-screen-screenshot' });
        this._stageScreenshot.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this._stageScreenshotContainer.add_child(this._stageScreenshot);

        this._openingCoroutineInProgress = false;
        this._grabHelper = new GrabHelper.GrabHelper(this, {
            actionMode: Shell.ActionMode.POPUP,
        });

        this._primaryMonitorBin = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        this._primaryMonitorBin.add_constraint(
            new Layout.MonitorConstraint({ 'primary': true }));
        this.add_child(this._primaryMonitorBin);

        this._panel = new St.BoxLayout({
            style_class: 'screenshot-ui-panel',
            y_align: Clutter.ActorAlign.END,
            y_expand: true,
            vertical: true,
        });
        this._primaryMonitorBin.add_child(this._panel);

        this._closeButton = new St.Button({
            style_class: 'screenshot-ui-close-button',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        this._closeButton.set_child(new St.Icon({ icon_name: 'window-close-symbolic' }));
        this._closeButton.connect('clicked', () => this.close());
        this._primaryMonitorBin.add_child(this._closeButton);

        this._typeButtonContainer = new St.Widget({
            style_class: 'screenshot-ui-type-button-container',
            layout_manager: new Clutter.BoxLayout({
                spacing: 12,
                homogeneous: true,
            }),
        });
        this._panel.add_child(this._typeButtonContainer);

        this._screenButton = new IconLabelButton('video-display-symbolic', _('Screen'), {
            style_class: 'screenshot-ui-type-button',
            checked: true,
            x_expand: true,
        });
        this._screenButton.connect('notify::checked',
            this._onScreenButtonToggled.bind(this));
        this._typeButtonContainer.add_child(this._screenButton);

        this._bottomRowContainer = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        this._panel.add_child(this._bottomRowContainer);

        this._captureButton = new St.Button({ style_class: 'screenshot-ui-capture-button' });
        this._captureButton.set_child(new St.Widget({
            style_class: 'screenshot-ui-capture-button-circle',
        }));
        this._captureButton.connect('clicked',
            this._onCaptureButtonClicked.bind(this));
        this._bottomRowContainer.add_child(this._captureButton);

        this._monitorBins = [];
        this._rebuildMonitorBins();

        Main.layoutManager.connect('monitors-changed', () => {
            // Nope, not dealing with monitor changes.
            this.close(true);
            this._rebuildMonitorBins();
        });

        Main.wm.addKeybinding(
            'show-screenshot-ui',
            new Gio.Settings({ schema_id: 'org.gnome.shell.keybindings' }),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL |
            Shell.ActionMode.OVERVIEW |
            Shell.ActionMode.SYSTEM_MODAL |
            Shell.ActionMode.LOOKING_GLASS |
            Shell.ActionMode.POPUP,
            showScreenshotUI
        );
    }

    _rebuildMonitorBins() {
        for (const bin of this._monitorBins)
            bin.destroy();

        this._monitorBins = [];
        this._screenSelectors = [];

        for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
            const bin = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
            });
            bin.add_constraint(new Layout.MonitorConstraint({ 'index': i }));
            this.insert_child_below(bin, this._primaryMonitorBin);
            this._monitorBins.push(bin);

            const screenSelector = new St.Button({
                style_class: 'screenshot-ui-screen-selector',
                x_expand: true,
                y_expand: true,
                visible: this._screenButton.checked,
                reactive: true,
                can_focus: true,
                toggle_mode: true,
            });
            screenSelector.connect('key-focus-in', () => {
                this.grab_key_focus();
                screenSelector.checked = true;
            });
            bin.add_child(screenSelector);
            this._screenSelectors.push(screenSelector);

            screenSelector.connect('notify::checked', () => {
                if (!screenSelector.checked)
                    return;

                screenSelector.toggle_mode = false;

                for (const otherSelector of this._screenSelectors) {
                    if (screenSelector === otherSelector)
                        continue;

                    otherSelector.toggle_mode = true;
                    otherSelector.checked = false;
                }
            });
        }

        if (Main.layoutManager.primaryIndex !== -1)
            this._screenSelectors[Main.layoutManager.primaryIndex].checked = true;
    }

    async open() {
        if (this._openingCoroutineInProgress)
            return;

        if (!this.visible) {
            // Screenshot UI is opening from completely closed state
            // (rather than opening back from in process of closing).
            this._shooter = new Shell.Screenshot();

            this._openingCoroutineInProgress = true;
            try {
                const [content, scale] =
                    await this._shooter.screenshot_stage_to_content();
                this._stageScreenshot.set_content(content);
                this._scale = scale;

                this._stageScreenshotContainer.show();
            } catch (e) {
                log('Error capturing screenshot: %s'.format(e.message));
            }
            this._openingCoroutineInProgress = false;
        }

        // Get rid of any popup menus.
        // We already have them captured on the screenshot anyway.
        //
        // This needs to happen before the grab below as closing menus will
        // pop their grabs.
        Main.layoutManager.emit('system-modal-opened');

        const grabResult = this._grabHelper.grab({
            actor: this,
            onUngrab: () => this.close(),
        });
        if (!grabResult)
            return;

        this.remove_all_transitions();
        this.visible = true;
        this.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._stageScreenshotContainer.get_parent().remove_child(
                    this._stageScreenshotContainer);
                this.insert_child_at_index(this._stageScreenshotContainer, 0);
            },
        });
    }

    _finishClosing() {
        this.hide();

        this._shooter = null;

        this._stageScreenshotContainer.get_parent().remove_child(
            this._stageScreenshotContainer);
        Main.layoutManager.screenshotUIGroup.insert_child_at_index(
            this._stageScreenshotContainer, 0);
        this._stageScreenshotContainer.hide();

        this._stageScreenshot.set_content(null);
    }

    close(instantly = false) {
        this._grabHelper.ungrab();

        if (instantly) {
            this._finishClosing();
            return;
        }

        this.remove_all_transitions();
        this.ease({
            opacity: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: this._finishClosing.bind(this),
        });
    }

    _onScreenButtonToggled() {
        if (this._screenButton.checked) {
            this._screenButton.toggle_mode = false;

            for (const selector of this._screenSelectors) {
                selector.show();
                selector.remove_all_transitions();
                selector.ease({
                    opacity: 255,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        } else {
            this._screenButton.toggle_mode = true;

            for (const selector of this._screenSelectors) {
                selector.remove_all_transitions();
                selector.ease({
                    opacity: 0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => selector.hide(),
                });
            }
        }
    }

    _onCaptureButtonClicked() {
        global.display.get_sound_player().play_from_theme(
            'screen-capture', _('Screenshot taken'), null);

        if (this._screenButton.checked) {
            const content = this._stageScreenshot.get_content();
            if (!content) {
                // Failed to capture the screenshot for some reason.
                this.close();
                return;
            }

            const texture = content.get_texture();
            const stream = Gio.MemoryOutputStream.new_resizable();

            const index =
                this._screenSelectors.findIndex(screen => screen.checked);
            const monitor = Main.layoutManager.monitors[index];

            const x = monitor.x * this._scale;
            const y = monitor.y * this._scale;
            const w = monitor.width * this._scale;
            const h = monitor.height * this._scale;

            Shell.Screenshot.composite_to_stream(
                texture,
                x, y, w, h,
                stream
            ).then(() => {
                stream.close(null);

                const clipboard = St.Clipboard.get_default();
                clipboard.set_content(
                    St.ClipboardType.CLIPBOARD,
                    'image/png',
                    stream.steal_as_bytes()
                );
            }).catch(err => {
                logError(err, 'Error capturing screenshot');
            });
        }

        this.close();
    }

    vfunc_key_press_event(event) {
        const symbol = event.keyval;
        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_space ||
            ((event.modifier_state & Clutter.ModifierType.CONTROL_MASK) &&
             (symbol === Clutter.KEY_c || symbol === Clutter.KEY_C))) {
            this._onCaptureButtonClicked();
            return Clutter.EVENT_STOP;
        }

        return super.vfunc_key_press_event(event);
    }
});

/**
 * Shows the screenshot UI.
 */
function showScreenshotUI() {
    Main.screenshotUI.open().catch(err => {
        logError(err, 'Error opening the screenshot UI');
    });
}

var ScreenshotService = class {
    constructor() {
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(ScreenshotIface, this);
        this._dbusImpl.export(Gio.DBus.session, '/org/gnome/Shell/Screenshot');

        this._screenShooter = new Map();
        this._senderChecker = new DBusSenderChecker([
            'org.gnome.SettingsDaemon.MediaKeys',
            'org.freedesktop.impl.portal.desktop.gtk',
            'org.freedesktop.impl.portal.desktop.gnome',
            'org.gnome.Screenshot',
        ]);

        this._lockdownSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.lockdown' });

        Gio.DBus.session.own_name('org.gnome.Shell.Screenshot', Gio.BusNameOwnerFlags.REPLACE, null, null);
    }

    async _createScreenshot(invocation, needsDisk = true, restrictCallers = true) {
        let lockedDown = false;
        if (needsDisk)
            lockedDown = this._lockdownSettings.get_boolean('disable-save-to-disk');

        let sender = invocation.get_sender();
        if (this._screenShooter.has(sender)) {
            invocation.return_error_literal(
                Gio.IOErrorEnum, Gio.IOErrorEnum.BUSY,
                'There is an ongoing operation for this sender');
            return null;
        } else if (lockedDown) {
            invocation.return_error_literal(
                Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED,
                'Saving to disk is disabled');
            return null;
        } else if (restrictCallers) {
            try {
                await this._senderChecker.checkInvocation(invocation);
            } catch (e) {
                invocation.return_gerror(e);
                return null;
            }
        }

        let shooter = new Shell.Screenshot();
        shooter._watchNameId =
                        Gio.bus_watch_name(Gio.BusType.SESSION, sender, 0, null,
                                           this._onNameVanished.bind(this));

        this._screenShooter.set(sender, shooter);

        return shooter;
    }

    _onNameVanished(connection, name) {
        this._removeShooterForSender(name);
    }

    _removeShooterForSender(sender) {
        let shooter = this._screenShooter.get(sender);
        if (!shooter)
            return;

        Gio.bus_unwatch_name(shooter._watchNameId);
        this._screenShooter.delete(sender);
    }

    _checkArea(x, y, width, height) {
        return x >= 0 && y >= 0 &&
               width > 0 && height > 0 &&
               x + width <= global.screen_width &&
               y + height <= global.screen_height;
    }

    *_resolveRelativeFilename(filename) {
        filename = filename.replace(/\.png$/, '');

        let path = [
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES),
            GLib.get_home_dir(),
        ].find(p => p && GLib.file_test(p, GLib.FileTest.EXISTS));

        if (!path)
            return null;

        yield Gio.File.new_for_path(
            GLib.build_filenamev([path, '%s.png'.format(filename)]));

        for (let idx = 1; ; idx++) {
            yield Gio.File.new_for_path(
                GLib.build_filenamev([path, '%s-%s.png'.format(filename, idx)]));
        }
    }

    _createStream(filename, invocation) {
        if (filename == '')
            return [Gio.MemoryOutputStream.new_resizable(), null];

        if (GLib.path_is_absolute(filename)) {
            try {
                let file = Gio.File.new_for_path(filename);
                let stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
                return [stream, file];
            } catch (e) {
                invocation.return_gerror(e);
                this._removeShooterForSender(invocation.get_sender());
                return [null, null];
            }
        }

        let err;
        for (let file of this._resolveRelativeFilename(filename)) {
            try {
                let stream = file.create(Gio.FileCreateFlags.NONE, null);
                return [stream, file];
            } catch (e) {
                err = e;
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    break;
            }
        }

        invocation.return_gerror(err);
        this._removeShooterForSender(invocation.get_sender());
        return [null, null];
    }

    _flashAsync(shooter) {
        return new Promise((resolve, _reject) => {
            shooter.connect('screenshot_taken', (s, area) => {
                const flashspot = new Flashspot(area);
                flashspot.fire(resolve);

                global.display.get_sound_player().play_from_theme(
                    'screen-capture', _('Screenshot taken'), null);
            });
        });
    }

    _onScreenshotComplete(stream, file, invocation) {
        stream.close(null);

        let filenameUsed = '';
        if (file) {
            filenameUsed = file.get_path();
        } else {
            let bytes = stream.steal_as_bytes();
            let clipboard = St.Clipboard.get_default();
            clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
        }

        let retval = GLib.Variant.new('(bs)', [true, filenameUsed]);
        invocation.return_value(retval);
    }

    _scaleArea(x, y, width, height) {
        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        x *= scaleFactor;
        y *= scaleFactor;
        width *= scaleFactor;
        height *= scaleFactor;
        return [x, y, width, height];
    }

    _unscaleArea(x, y, width, height) {
        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        x /= scaleFactor;
        y /= scaleFactor;
        width /= scaleFactor;
        height /= scaleFactor;
        return [x, y, width, height];
    }

    async ScreenshotAreaAsync(params, invocation) {
        let [x, y, width, height, flash, filename] = params;
        [x, y, width, height] = this._scaleArea(x, y, width, height);
        if (!this._checkArea(x, y, width, height)) {
            invocation.return_error_literal(Gio.IOErrorEnum,
                                            Gio.IOErrorEnum.CANCELLED,
                                            "Invalid params");
            return;
        }
        let screenshot = await this._createScreenshot(invocation);
        if (!screenshot)
            return;

        let [stream, file] = this._createStream(filename, invocation);
        if (!stream)
            return;

        try {
            await Promise.all([
                flash ? this._flashAsync(screenshot) : null,
                screenshot.screenshot_area(x, y, width, height, stream),
            ]);
            this._onScreenshotComplete(stream, file, invocation);
        } catch (e) {
            invocation.return_value(new GLib.Variant('(bs)', [false, '']));
        } finally {
            this._removeShooterForSender(invocation.get_sender());
        }
    }

    async ScreenshotWindowAsync(params, invocation) {
        let [includeFrame, includeCursor, flash, filename] = params;
        let screenshot = await this._createScreenshot(invocation);
        if (!screenshot)
            return;

        let [stream, file] = this._createStream(filename, invocation);
        if (!stream)
            return;

        try {
            await Promise.all([
                flash ? this._flashAsync(screenshot) : null,
                screenshot.screenshot_window(includeFrame, includeCursor, stream),
            ]);
            this._onScreenshotComplete(stream, file, invocation);
        } catch (e) {
            invocation.return_value(new GLib.Variant('(bs)', [false, '']));
        } finally {
            this._removeShooterForSender(invocation.get_sender());
        }
    }

    async ScreenshotAsync(params, invocation) {
        let [includeCursor, flash, filename] = params;
        let screenshot = await this._createScreenshot(invocation);
        if (!screenshot)
            return;

        let [stream, file] = this._createStream(filename, invocation);
        if (!stream)
            return;

        try {
            await Promise.all([
                flash ? this._flashAsync(screenshot) : null,
                screenshot.screenshot(includeCursor, stream),
            ]);
            this._onScreenshotComplete(stream, file, invocation);
        } catch (e) {
            invocation.return_value(new GLib.Variant('(bs)', [false, '']));
        } finally {
            this._removeShooterForSender(invocation.get_sender());
        }
    }

    async SelectAreaAsync(params, invocation) {
        try {
            await this._senderChecker.checkInvocation(invocation);
        } catch (e) {
            invocation.return_gerror(e);
            return;
        }

        let selectArea = new SelectArea();
        try {
            let areaRectangle = await selectArea.selectAsync();
            let retRectangle = this._unscaleArea(
                areaRectangle.x, areaRectangle.y,
                areaRectangle.width, areaRectangle.height);
            invocation.return_value(GLib.Variant.new('(iiii)', retRectangle));
        } catch (e) {
            invocation.return_error_literal(
                Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED,
                'Operation was cancelled');
        }
    }

    async FlashAreaAsync(params, invocation) {
        try {
            await this._senderChecker.checkInvocation(invocation);
        } catch (e) {
            invocation.return_gerror(e);
            return;
        }

        let [x, y, width, height] = params;
        [x, y, width, height] = this._scaleArea(x, y, width, height);
        if (!this._checkArea(x, y, width, height)) {
            invocation.return_error_literal(Gio.IOErrorEnum,
                                            Gio.IOErrorEnum.CANCELLED,
                                            "Invalid params");
            return;
        }
        let flashspot = new Flashspot({ x, y, width, height });
        flashspot.fire();
        invocation.return_value(null);
    }

    async PickColorAsync(params, invocation) {
        const screenshot = await this._createScreenshot(invocation, false, false);
        if (!screenshot)
            return;

        const pickPixel = new PickPixel(screenshot);
        try {
            const color = await pickPixel.pickAsync();
            const { red, green, blue } = color;
            const retval = GLib.Variant.new('(a{sv})', [{
                color: GLib.Variant.new('(ddd)', [
                    red / 255.0,
                    green / 255.0,
                    blue / 255.0,
                ]),
            }]);
            invocation.return_value(retval);
        } catch (e) {
            invocation.return_error_literal(
                Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED,
                'Operation was cancelled');
        } finally {
            this._removeShooterForSender(invocation.get_sender());
        }
    }
};

var SelectArea = GObject.registerClass(
class SelectArea extends St.Widget {
    _init() {
        this._startX = -1;
        this._startY = -1;
        this._lastX = 0;
        this._lastY = 0;
        this._result = null;

        super._init({
            visible: false,
            reactive: true,
            x: 0,
            y: 0,
        });
        Main.uiGroup.add_actor(this);

        this._grabHelper = new GrabHelper.GrabHelper(this);

        let constraint = new Clutter.BindConstraint({ source: global.stage,
                                                      coordinate: Clutter.BindCoordinate.ALL });
        this.add_constraint(constraint);

        this._rubberband = new St.Widget({
            style_class: 'select-area-rubberband',
            visible: false,
        });
        this.add_actor(this._rubberband);
    }

    async selectAsync() {
        global.display.set_cursor(Meta.Cursor.CROSSHAIR);
        Main.uiGroup.set_child_above_sibling(this, null);
        this.show();

        try {
            await this._grabHelper.grabAsync({ actor: this });
        } finally {
            global.display.set_cursor(Meta.Cursor.DEFAULT);

            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this.destroy();
                return GLib.SOURCE_REMOVE;
            });
        }

        return this._result;
    }

    _getGeometry() {
        return new Meta.Rectangle({
            x: Math.min(this._startX, this._lastX),
            y: Math.min(this._startY, this._lastY),
            width: Math.abs(this._startX - this._lastX) + 1,
            height: Math.abs(this._startY - this._lastY) + 1,
        });
    }

    vfunc_motion_event(motionEvent) {
        if (this._startX == -1 || this._startY == -1 || this._result)
            return Clutter.EVENT_PROPAGATE;

        [this._lastX, this._lastY] = [motionEvent.x, motionEvent.y];
        this._lastX = Math.floor(this._lastX);
        this._lastY = Math.floor(this._lastY);
        let geometry = this._getGeometry();

        this._rubberband.set_position(geometry.x, geometry.y);
        this._rubberband.set_size(geometry.width, geometry.height);
        this._rubberband.show();

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_press_event(buttonEvent) {
        if (this._result)
            return Clutter.EVENT_PROPAGATE;

        [this._startX, this._startY] = [buttonEvent.x, buttonEvent.y];
        this._startX = Math.floor(this._startX);
        this._startY = Math.floor(this._startY);
        this._rubberband.set_position(this._startX, this._startY);

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event() {
        if (this._startX === -1 || this._startY === -1 || this._result)
            return Clutter.EVENT_PROPAGATE;

        this._result = this._getGeometry();
        this.ease({
            opacity: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._grabHelper.ungrab(),
        });
        return Clutter.EVENT_PROPAGATE;
    }
});

var RecolorEffect = GObject.registerClass({
    Properties: {
        color: GObject.ParamSpec.boxed(
            'color', 'color', 'replacement color',
            GObject.ParamFlags.WRITABLE,
            Clutter.Color.$gtype),
        chroma: GObject.ParamSpec.boxed(
            'chroma', 'chroma', 'color to replace',
            GObject.ParamFlags.WRITABLE,
            Clutter.Color.$gtype),
        threshold: GObject.ParamSpec.float(
            'threshold', 'threshold', 'threshold',
            GObject.ParamFlags.WRITABLE,
            0.0, 1.0, 0.0),
        smoothing: GObject.ParamSpec.float(
            'smoothing', 'smoothing', 'smoothing',
            GObject.ParamFlags.WRITABLE,
            0.0, 1.0, 0.0),
    },
}, class RecolorEffect extends Shell.GLSLEffect {
    _init(params) {
        this._color = new Clutter.Color();
        this._chroma = new Clutter.Color();
        this._threshold = 0;
        this._smoothing = 0;

        this._colorLocation = null;
        this._chromaLocation = null;
        this._thresholdLocation = null;
        this._smoothingLocation = null;

        super._init(params);

        this._colorLocation = this.get_uniform_location('recolor_color');
        this._chromaLocation = this.get_uniform_location('chroma_color');
        this._thresholdLocation = this.get_uniform_location('threshold');
        this._smoothingLocation = this.get_uniform_location('smoothing');

        this._updateColorUniform(this._colorLocation, this._color);
        this._updateColorUniform(this._chromaLocation, this._chroma);
        this._updateFloatUniform(this._thresholdLocation, this._threshold);
        this._updateFloatUniform(this._smoothingLocation, this._smoothing);
    }

    _updateColorUniform(location, color) {
        if (!location)
            return;

        this.set_uniform_float(location,
            3, [color.red / 255, color.green / 255, color.blue / 255]);
        this.queue_repaint();
    }

    _updateFloatUniform(location, value) {
        if (!location)
            return;

        this.set_uniform_float(location, 1, [value]);
        this.queue_repaint();
    }

    set color(c) {
        if (this._color.equal(c))
            return;

        this._color = c;
        this.notify('color');

        this._updateColorUniform(this._colorLocation, this._color);
    }

    set chroma(c) {
        if (this._chroma.equal(c))
            return;

        this._chroma = c;
        this.notify('chroma');

        this._updateColorUniform(this._chromaLocation, this._chroma);
    }

    set threshold(value) {
        if (this._threshold === value)
            return;

        this._threshold = value;
        this.notify('threshold');

        this._updateFloatUniform(this._thresholdLocation, this._threshold);
    }

    set smoothing(value) {
        if (this._smoothing === value)
            return;

        this._smoothing = value;
        this.notify('smoothing');

        this._updateFloatUniform(this._smoothingLocation, this._smoothing);
    }

    vfunc_build_pipeline() {
        // Conversion parameters from https://en.wikipedia.org/wiki/YCbCr
        const decl = `
            vec3 rgb2yCrCb(vec3 c) {                                \n
                float y = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;  \n
                float cr = 0.7133 * (c.r - y);                      \n
                float cb = 0.5643 * (c.b - y);                      \n
                return vec3(y, cr, cb);                             \n
            }                                                       \n
                                                                    \n
            uniform vec3 chroma_color;                              \n
            uniform vec3 recolor_color;                             \n
            uniform float threshold;                                \n
            uniform float smoothing;                                \n`;
        const src = `
            vec3 mask = rgb2yCrCb(chroma_color.rgb);                \n
            vec3 yCrCb = rgb2yCrCb(cogl_color_out.rgb);             \n
            float blend =                                           \n
              smoothstep(threshold,                                 \n
                         threshold + smoothing,                     \n
                         distance(yCrCb.gb, mask.gb));              \n
            cogl_color_out.rgb =                                    \n
              mix(recolor_color, cogl_color_out.rgb, blend);        \n`;

        this.add_glsl_snippet(Shell.SnippetHook.FRAGMENT, decl, src, false);
    }
});

var PickPixel = GObject.registerClass(
class PickPixel extends St.Widget {
    _init(screenshot) {
        super._init({ visible: false, reactive: true });

        this._screenshot = screenshot;

        this._result = null;
        this._color = null;
        this._inPick = false;

        Main.uiGroup.add_actor(this);

        this._grabHelper = new GrabHelper.GrabHelper(this);

        let constraint = new Clutter.BindConstraint({ source: global.stage,
                                                      coordinate: Clutter.BindCoordinate.ALL });
        this.add_constraint(constraint);

        const action = new Clutter.ClickAction();
        action.connect('clicked', async () => {
            await this._pickColor(...action.get_coords());
            this._result = this._color;
            this._grabHelper.ungrab();
        });
        this.add_action(action);

        this._recolorEffect = new RecolorEffect({
            chroma: new Clutter.Color({
                red: 80,
                green: 219,
                blue: 181,
            }),
            threshold: 0.04,
            smoothing: 0.07,
        });
        this._previewCursor = new St.Icon({
            icon_name: 'color-pick',
            icon_size: Meta.prefs_get_cursor_size(),
            effect: this._recolorEffect,
            visible: false,
        });
        Main.uiGroup.add_actor(this._previewCursor);
    }

    async pickAsync() {
        global.display.set_cursor(Meta.Cursor.BLANK);
        Main.uiGroup.set_child_above_sibling(this, null);
        this.show();

        this._pickColor(...global.get_pointer());

        try {
            await this._grabHelper.grabAsync({ actor: this });
        } finally {
            global.display.set_cursor(Meta.Cursor.DEFAULT);
            this._previewCursor.destroy();

            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this.destroy();
                return GLib.SOURCE_REMOVE;
            });
        }

        return this._result;
    }

    async _pickColor(x, y) {
        if (this._inPick)
            return;

        this._inPick = true;
        this._previewCursor.set_position(x, y);
        [this._color] = await this._screenshot.pick_color(x, y);
        this._inPick = false;

        if (!this._color)
            return;

        this._recolorEffect.color = this._color;
        this._previewCursor.show();
    }

    vfunc_motion_event(motionEvent) {
        const { x, y } = motionEvent;
        this._pickColor(x, y);
        return Clutter.EVENT_PROPAGATE;
    }
});

var FLASHSPOT_ANIMATION_OUT_TIME = 500; // milliseconds

var Flashspot = GObject.registerClass(
class Flashspot extends Lightbox.Lightbox {
    _init(area) {
        super._init(Main.uiGroup, {
            inhibitEvents: true,
            width: area.width,
            height: area.height,
        });
        this.style_class = 'flashspot';
        this.set_position(area.x, area.y);
    }

    fire(doneCallback) {
        this.set({ visible: true, opacity: 255 });
        this.ease({
            opacity: 0,
            duration: FLASHSPOT_ANIMATION_OUT_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (doneCallback)
                    doneCallback();
                this.destroy();
            },
        });
    }
});
