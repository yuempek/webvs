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

/** 
 * Options for Main constructor
 */
export interface IMainOpts {
    /** 
     * Canvas element in which the visualization will be rendered
     */
    canvas: HTMLCanvasElement;
    /**
     * an analyser that will provide music data for the visualizations
     */
    analyser: AnalyserAdapter;
    /** 
     * show or hide performance stats
     */
    showStat?: boolean;
    /** 
     * Override baked-in resource url prefix for builtin resources
     */
    resourcePrefix?: string;
    /** 
     * Custom requestAnimationFrame. Useful for testing/custom frame-rate control.
     * Use together with [[cancelAnimationFrame]]
     */
    requestAnimationFrame?: (callback: () => void) => any;
    /** 
     * Custom cancelAnimationFrame. Useful for testing/custom frame-rate control.
     * Use together with [[requestAnimationFrame]]
     */
    cancelAnimationFrame?: (reqId: any) => void;
}

/** 
 * Main is the primary interface that controls loading of presets, starting stopping animations, etc.
 * It maintains the root Component and the hierarchy of components under it. 
 * A typical usage involves creating an Analyser and a Main object. The Analyser interfaces with your 
 * audio source and generates the visualization data, while the Main object serves as the primary 
 * interface for controlling the visualization. E.g:
 * ```
 * const analyser = new Webvs.WebAudioAnalyser();
 * const webvs = new Webvs.Main({
 *     canvas: document.getElementById("canvas"),
 *     analyser: analyser,
 *     showStat: true
 * });
 * webvs.loadPreset({
 *   "clearFrame": true,
 *   "components": [
 *       {
 *           "type": "SuperScope",
 *           "source": "WAVEFORM",
 *           "code": {
 *               "perPoint": "x=i*2-1;y=v;"
 *           },
 *           "colors": ["#ffffff"]
 *       }
 *   ]
 * });
 * webvs.start();
 * analyser.load("music.ogg");
 * analyser.play();
 * ```
 */
export default class Main extends Model implements IMain {
    /**
     * version of Webvs library
     */
    public static version: string = WEBVS_VERSION;
    /**
     * Analyser instance that's used to get music data for the visualization
     */
    public analyser: AnalyserAdapter;
    /**
     * Resource Manager that manages media resources
     */
    public rsrcMan: ResourceManager;
    /**
     * Rendering context for webgl rendering
     */
    public rctx: RenderingContext;
    /**
     * A shader program that can be used to copy frames
     */
    public copier: CopyProgram;
    /**
     * A registry of [[Component]] classes that will be used to create preset effects
     */
    public componentRegistry: ComponentRegistry;
    /**
     * A manager for temporary buffers.
     */
    public tempBuffers: FrameBufferManager;
    /**
     * Map of shared register values available in EEL code in components.
     */
    public registerBank: {[key: string]: number};
    /**
     * Timestamp at which Main was constructed
     */
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

    /**
     * Constructs a Webvs Main object that can load and render visualization presets
     * @param options options for Main
     */
    constructor(options: IMainOpts) {
        super();
        checkRequiredOptions(options, ["canvas", "analyser"]);
        options = _.defaults(options, {
            showStat: false,
        });
        this.canvas = options.canvas;
        this.analyser = options.analyser;
        this.isStarted = false;
        if (options.requestAnimationFrame && options.cancelAnimationFrame) {
            this.requestAnimationFrame = options.requestAnimationFrame;
            this.cancelAnimationFrame = options.cancelAnimationFrame;
        } else {
            this.requestAnimationFrame = window.requestAnimationFrame.bind(window);
            this.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
        }
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

    /** 
     * Starts running the animation when ready. The animation may not start 
     * playing immediately because preset may use external resources which 
     * needs to be loaded asynchronously by the resource manager. 
     */
    public start() {
        if (this.isStarted) {
            return;
        }
        this.isStarted = true;
        if (this.rsrcMan.ready) {
            this._startAnimation();
        }
    }

    /** 
     * Stops the animation
     */
    public stop() {
        if (!this.isStarted) {
            return;
        }
        this.isStarted = false;
        if (this.rsrcMan.ready) {
            this._stopAnimation();
        }
    }

    /**
     * Loads a preset into this webvs main instance.
     * 
     * @param preset an object that contains the preset. The root object should 
     * have a `components` property which will contain an Array for component configurations 
     * for all the components. All component configurations should have a 
     * `type` property containing the string name of the Component. Other 
     * properties are specific to each component. The `resources.uris` property 
     * in preset is used to register resources with [[ResourceManager]] and has 
     * the same format accepted by the [[ResourceManager.registerUri]].
     */
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

    /** 
     * Resets and reinitializes all the components and canvas. 
     */
    public resetCanvas() {
        const preset = this.rootComponent.toJSON();
        this.rootComponent.destroy();
        this.tempBuffers.destroy();
        this._initGl();
        this._setupRoot(preset);
    }

    /** 
     * This function should be called if the canvas element's 
     * width or height attribute has changed. This allows Webvs 
     * to update and resize all the buffers. 
     */
    public notifyResize() {
        const gl = this.rctx.gl;
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        this.tempBuffers.resize();
        this.emit("resize", gl.drawingBufferWidth, gl.drawingBufferHeight);
    }

    /**
     * Cache webgl Buffers. Useful to store buffers that can be shared. e.g. geometries.
     * @param name Name of the buffer
     * @param buffer Buffer to be cached
     */
    public cacheBuffer(name: string, buffer: Buffer) {
        this.buffers[name] = buffer;
    }

    /**
     * Returns buffer cached under given name
     * @param name Name of the buffer
     * @returns The buffer cached under given name. `undefined` if not found.
     */
    public getBuffer(name: string): Buffer {
        return this.buffers[name];
    }

    /**
     * Gets the current value of a preset property. Eg. `main.get("meta")`
     * @param key preset property to be returned
     */
    public get(key: string) {
        if (key === "meta") {
            return this.meta;
        }
    }

    /** 
     * Generates and returns the instantaneous preset JSON representation
     * @returns JSON representaton of the preset
     */
    public toJSON(): any {
        let preset = this.rootComponent.toJSON();
        preset = _.pick(preset, "clearFrame", "components");
        preset.resources = this.rsrcMan.toJSON();
        preset.meta = _.clone(this.meta);
        return preset;
    }

    /**
     * Destroys and cleans up all resources
     */
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

    protected setAttribute(key: string, value: any, options: any) {
        if (key === "meta") {
            this.meta = value;
            return true;
        }
        return false;
    }


    // event handlers
    private handleRsrcWait() {
        if (this.isStarted) {
            this._stopAnimation();
        }
    }

    private handleRsrcReady() {
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
