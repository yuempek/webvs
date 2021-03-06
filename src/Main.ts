import * as _ from "lodash";
import Stats from "stats.js";
import AnalyserAdapter from "./analyser/AnalyserAdapter";
import Component from "./Component";
import ComponentRegistry from "./ComponentRegistry";
import EffectList from "./EffectList";
import IMain from "./IMain";
import BufferSave from "./misc/BufferSave";
import GlobalVar from "./misc/GlobalVar";
import Model from "./Model";
import ClearScreen from "./render/ClearScreen";
import MovingParticle from "./render/MovingParticle";
import Picture from "./render/Picture";
import SuperScope from "./render/SuperScope";
import Texer from "./render/Texer";
import ResourceManager from "./ResourceManager";
import ResourcePack from "./ResourcePack";
import ChannelShift from "./trans/ChannelShift";
import ColorClip from "./trans/ColorClip";
import ColorMap from "./trans/ColorMap";
import Convolution from "./trans/Convolution";
import DynamicMovement from "./trans/DynamicMovement";
import FadeOut from "./trans/FadeOut";
import Invert from "./trans/Invert";
import Mirror from "./trans/Mirror";
import Mosaic from "./trans/Mosaic";
import UniqueTone from "./trans/UniqueTone";
import {checkRequiredOptions} from "./utils";
import Buffer from "./webgl/Buffer";
import CopyProgram from "./webgl/CopyProgram";
import FrameBufferManager from "./webgl/FrameBufferManager";
import RenderingContext from "./webgl/RenderingContext";

declare var WEBVS_VERSION: string;

export interface IMainOpts {
    canvas: HTMLCanvasElement;
    analyser: AnalyserAdapter;
    showStat?: boolean;
    resourcePrefix?: string;
    requestAnimationFrame?: (callback: () => void) => any;
    cancelAnimationFrame?: (reqId: any) => void;
}

// Main Webvs object, that represents a running webvs instance.
export default class Main extends Model implements IMain {
    public static version: string = WEBVS_VERSION;
    public analyser: AnalyserAdapter;
    public rsrcMan: ResourceManager;
    public rctx: RenderingContext;
    public copier: CopyProgram;
    public componentRegistry: ComponentRegistry;
    public tempBuffers: FrameBufferManager;
    public registerBank: {[key: string]: number};
    public bootTime: number;
    private canvas: HTMLCanvasElement;
    private isStarted: boolean;
    private stats: Stats;
    private meta: any;
    private rootComponent: Component;
    private animReqId: number;
    private buffers: {[name: string]: Buffer};
    private requestAnimationFrame: (callback: () => void) => any;
    private cancelAnimationFrame: (reqId: any) => void;
    private presetResourceKeys: string[] = [];
    private contextLostHander: (event: any) => void;
    private contextRestoredHander: (event: any) => void;

    constructor(options: IMainOpts) {
        super();
        checkRequiredOptions(options, ["canvas", "analyser"]);
        options = _.defaults(options, {
            showStat: false,
        });
        this.canvas = options.canvas;
        this.analyser = options.analyser;
        this.isStarted = false;
        this.requestAnimationFrame = options.requestAnimationFrame || window.requestAnimationFrame.bind(window);
        this.cancelAnimationFrame = options.cancelAnimationFrame || window.cancelAnimationFrame.bind(window);
        if (options.showStat) {
            const stats = new Stats();
            stats.setMode(0);
            stats.domElement.style.position = "absolute";
            stats.domElement.style.right = "5px";
            stats.domElement.style.bottom = "5px";
            document.body.appendChild(stats.domElement);
            this.stats = stats;
        }

        this.meta = {};
        this._initComponentRegistry();
        this._initResourceManager(options.resourcePrefix || "");
        this._registerContextEvents();
        this._initGl();
        this._setupRoot({id: "root"});
    }

    // Starts the animation if not already started
    public start() {
        if (this.isStarted) {
            return;
        }
        this.isStarted = true;
        if (this.rsrcMan.ready) {
            this._startAnimation();
        }
    }

    // Stops the animation
    public stop() {
        if (!this.isStarted) {
            return;
        }
        this.isStarted = false;
        if (this.rsrcMan.ready) {
            this._stopAnimation();
        }
    }

    // Loads a preset JSON. If a preset is already loaded and running, then
    // the animation is stopped, and the new preset is loaded.
    public loadPreset(preset: any) {
        preset = _.clone(preset); // use our own copy
        preset.id = "root";
        this.rootComponent.destroy();

        // setup resources
        this.rsrcMan.clear(this.presetResourceKeys);
        if ("resources" in preset && "uris" in preset.resources) {
            this.rsrcMan.registerUri(preset.resources.uris);
            this.presetResourceKeys = Object.keys(preset.resources.uris);
        } else {
            this.presetResourceKeys = [];
        }

        // load meta
        this.meta = _.clone(preset.meta);

        this._setupRoot(preset);
    }

    // Reset all the components.
    public resetCanvas() {
        const preset = this.rootComponent.toJSON();
        this.rootComponent.destroy();
        this.tempBuffers.destroy();
        this._initGl();
        this._setupRoot(preset);
    }

    public notifyResize() {
        const gl = this.rctx.gl;
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        this.tempBuffers.resize();
        this.emit("resize", gl.drawingBufferWidth, gl.drawingBufferHeight);
    }

    public cacheBuffer(name: string, buffer: Buffer) {
        this.buffers[name] = buffer;
    }

    public getBuffer(name: string): Buffer {
        return this.buffers[name];
    }

    public setAttribute(key: string, value: any, options: any) {
        if (key === "meta") {
            this.meta = value;
            return true;
        }
        return false;
    }

    public get(key: string) {
        if (key === "meta") {
            return this.meta;
        }
    }

    // Generates and returns the instantaneous preset JSON
    // representation
    public toJSON(): any {
        let preset = this.rootComponent.toJSON();
        preset = _.pick(preset, "clearFrame", "components");
        preset.resources = this.rsrcMan.toJSON();
        preset.meta = _.clone(this.meta);
        return preset;
    }

    public destroy() {
        this.stop();
        this.rootComponent.destroy();
        this.rootComponent = null;
        if (this.stats) {
            const statsDomElement = this.stats.domElement;
            statsDomElement.parentNode.removeChild(statsDomElement);
            this.stats = null;
        }
        this.rsrcMan = null;
        this.stopListening();
        this.canvas.removeEventListener("webglcontextlost", this.contextLostHander);
        this.canvas.removeEventListener("webglcontextrestored", this.contextRestoredHander);
    }

    // event handlers
    public handleRsrcWait() {
        if (this.isStarted) {
            this._stopAnimation();
        }
    }

    public handleRsrcReady() {
        if (this.isStarted) {
            this._startAnimation();
        }
    }

    private _initComponentRegistry() {
        this.componentRegistry = new ComponentRegistry([
            EffectList,

            ClearScreen,
            MovingParticle,
            Picture,
            SuperScope,
            Texer,

            ChannelShift,
            ColorClip,
            ColorMap,
            Convolution,
            DynamicMovement,
            FadeOut,
            Invert,
            Mirror,
            Mosaic,
            UniqueTone,

            BufferSave,
            GlobalVar,
        ]);
    }

    private _initResourceManager(prefix: string): void {
        let builtinPack = ResourcePack;
        if (prefix) {
            builtinPack = _.clone(builtinPack);
            builtinPack.prefix = prefix;
        }
        this.rsrcMan = new ResourceManager(builtinPack);
        this.listenTo(this.rsrcMan, "wait", this.handleRsrcWait.bind(this));
        this.listenTo(this.rsrcMan, "ready", this.handleRsrcReady.bind(this));
    }

    private _registerContextEvents() {
        this.contextLostHander = (event) => {
            event.preventDefault();
            this.stop();
        };
        this.canvas.addEventListener("webglcontextlost", this.contextLostHander);

        this.contextRestoredHander = (event) => {
            this.resetCanvas();
        };
        this.canvas.addEventListener("webglcontextrestored", this.contextRestoredHander);
    }

    private _initGl() {
        try {
            this.rctx = new RenderingContext(this.canvas.getContext("webgl", {alpha: false}));
            this.copier = new CopyProgram(this.rctx, true);
            this.tempBuffers = new FrameBufferManager(this.rctx, this.copier, true, 0);
        } catch (e) {
            throw new Error("Couldnt get webgl context" + e);
        }
    }

    private _setupRoot(preset: any) {
        this.registerBank = {};
        this.bootTime = (new Date()).getTime();
        this.rootComponent = new EffectList(this, null, preset);
    }

    private _startAnimation() {
        let drawFrame = () => {
            this.analyser.update();
            this.rootComponent.draw();
            this.animReqId = this.requestAnimationFrame(drawFrame);
        };

        // Wrap drawframe in stats collection if required
        if (this.stats) {
            const oldDrawFrame = drawFrame;
            drawFrame = () => {
                this.stats.begin();
                oldDrawFrame();
                this.stats.end();
            };
        }
        this.animReqId = this.requestAnimationFrame(drawFrame);
    }

    private _stopAnimation() {
        this.cancelAnimationFrame(this.animReqId);
    }
}
