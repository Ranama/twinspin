namespace JsCheck;

/// <summary>Names that exist as globals in a browser page, used by the undeclared-variable check.</summary>
internal static class Globals
{
    private const string EcmaScript = """
        AggregateError Array ArrayBuffer AsyncDisposableStack Atomics BigInt BigInt64Array BigUint64Array Boolean
        DataView Date DisposableStack Error EvalError FinalizationRegistry Float16Array Float32Array Float64Array
        Function Infinity Int16Array Int32Array Int8Array Intl Iterator JSON Map Math NaN Number Object Promise
        Proxy RangeError ReferenceError Reflect RegExp Set SharedArrayBuffer String SuppressedError Symbol
        SyntaxError TypeError URIError Uint16Array Uint32Array Uint8Array Uint8ClampedArray WeakMap WeakRef WeakSet
        decodeURI decodeURIComponent encodeURI encodeURIComponent escape eval globalThis isFinite isNaN parseFloat
        parseInt undefined unescape arguments
        """;

    private const string Browser = """
        window self document navigator location history screen console performance localStorage sessionStorage
        indexedDB caches crypto fetch Request Response Headers FormData URL URLSearchParams URLPattern Blob File
        FileReader FileList AbortController AbortSignal WebSocket EventSource XMLHttpRequest Worker SharedWorker
        ServiceWorker MessageChannel MessagePort MessageEvent BroadcastChannel setTimeout clearTimeout setInterval
        clearInterval requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback
        queueMicrotask structuredClone atob btoa alert confirm prompt open close print focus blur stop postMessage
        getComputedStyle getSelection matchMedia scrollTo scrollBy scroll moveTo moveBy resizeTo resizeBy
        innerWidth innerHeight outerWidth outerHeight devicePixelRatio scrollX scrollY pageXOffset pageYOffset
        screenX screenY screenLeft screenTop visualViewport frames parent top opener name status closed length
        origin isSecureContext crossOriginIsolated customElements addEventListener removeEventListener
        dispatchEvent reportError createImageBitmap event external frameElement speechSynthesis
        onload onerror onresize onkeydown onkeyup onkeypress onblur onfocus onbeforeunload onunload onpopstate
        onhashchange onmessage onpointerdown onpointerup onpointermove onmousedown onmouseup onmousemove onclick
        ontouchstart ontouchend ontouchmove onvisibilitychange onwheel onorientationchange ondevicemotion
        ondeviceorientation ongamepadconnected ongamepaddisconnected onunhandledrejection onpagehide onpageshow
        Event EventTarget CustomEvent ErrorEvent UIEvent KeyboardEvent MouseEvent PointerEvent TouchEvent Touch
        TouchList WheelEvent FocusEvent InputEvent CompositionEvent DragEvent ClipboardEvent ProgressEvent
        PopStateEvent HashChangeEvent PageTransitionEvent StorageEvent CloseEvent GamepadEvent Gamepad
        GamepadButton GamepadHapticActuator DeviceOrientationEvent DeviceMotionEvent AnimationEvent TransitionEvent
        PromiseRejectionEvent SubmitEvent BeforeUnloadEvent SecurityPolicyViolationEvent
        Node Element HTMLElement HTMLDocument Document DocumentFragment Text Comment Attr CharacterData NodeList
        HTMLCollection DOMParser XMLSerializer DOMRect DOMRectReadOnly DOMPoint DOMPointReadOnly DOMMatrix
        DOMMatrixReadOnly DOMQuad DOMException DOMTokenList DOMStringMap DOMImplementation ShadowRoot Range
        StaticRange Selection MutationObserver MutationRecord ResizeObserver ResizeObserverEntry
        IntersectionObserver IntersectionObserverEntry PerformanceObserver NodeFilter NodeIterator TreeWalker
        XPathResult XPathEvaluator HTMLCanvasElement HTMLImageElement HTMLVideoElement HTMLAudioElement
        HTMLMediaElement HTMLInputElement HTMLButtonElement HTMLDivElement HTMLSpanElement HTMLAnchorElement
        HTMLFormElement HTMLSelectElement HTMLOptionElement HTMLTextAreaElement HTMLLabelElement HTMLStyleElement
        HTMLScriptElement HTMLBodyElement HTMLHeadElement HTMLHtmlElement HTMLParagraphElement HTMLHeadingElement
        HTMLTemplateElement HTMLDialogElement HTMLIFrameElement HTMLLinkElement HTMLMetaElement HTMLUListElement
        HTMLOListElement HTMLLIElement HTMLTableElement HTMLTableRowElement HTMLTableCellElement
        HTMLProgressElement HTMLSlotElement HTMLSourceElement HTMLPictureElement HTMLPreElement HTMLBRElement
        HTMLHRElement HTMLUnknownElement HTMLFieldSetElement HTMLLegendElement HTMLOutputElement HTMLMeterElement
        HTMLDetailsElement HTMLObjectElement HTMLEmbedElement HTMLTitleElement HTMLBaseElement HTMLDataListElement
        SVGElement SVGSVGElement SVGGraphicsElement SVGPathElement SVGGElement SVGRectElement SVGCircleElement
        SVGTextElement SVGImageElement SVGPoint SVGMatrix
        Image Audio Option CanvasRenderingContext2D OffscreenCanvas OffscreenCanvasRenderingContext2D ImageBitmap
        ImageBitmapRenderingContext ImageData Path2D CanvasGradient CanvasPattern TextMetrics VideoFrame
        WebGLRenderingContext WebGL2RenderingContext WebGLBuffer WebGLProgram WebGLShader WebGLTexture
        WebGLFramebuffer WebGLRenderbuffer WebGLUniformLocation WebGLVertexArrayObject WebGLQuery WebGLSampler
        WebGLSync WebGLTransformFeedback WebGLActiveInfo WebGLShaderPrecisionFormat WebGLContextEvent
        GPU GPUAdapter GPUDevice GPUBuffer GPUTexture GPUShaderStage GPUBufferUsage GPUTextureUsage GPUMapMode
        GPUColorWrite GPUCanvasContext
        AudioContext webkitAudioContext OfflineAudioContext BaseAudioContext AudioBuffer AudioBufferSourceNode
        AudioNode AudioParam AudioDestinationNode AudioListener AudioScheduledSourceNode GainNode OscillatorNode
        BiquadFilterNode ConvolverNode DelayNode DynamicsCompressorNode PannerNode StereoPannerNode AnalyserNode
        WaveShaperNode ChannelMergerNode ChannelSplitterNode MediaElementAudioSourceNode MediaStreamAudioSourceNode
        MediaStreamAudioDestinationNode ConstantSourceNode IIRFilterNode AudioWorkletNode AudioWorklet PeriodicWave
        AudioData MediaStream MediaStreamTrack MediaRecorder MediaSource MediaQueryList MediaError TimeRanges
        Notification TextEncoder TextDecoder TextEncoderStream TextDecoderStream ReadableStream WritableStream
        TransformStream ReadableStreamDefaultReader WritableStreamDefaultWriter ByteLengthQueuingStrategy
        CountQueuingStrategy CompressionStream DecompressionStream
        CSS CSSStyleSheet CSSStyleDeclaration CSSRule CSSRuleList StyleSheet StyleSheetList FontFace FontFaceSet
        SubtleCrypto Crypto CryptoKey Cache CacheStorage IDBDatabase IDBKeyRange IDBRequest IDBOpenDBRequest
        IDBTransaction IDBObjectStore IDBIndex IDBCursor IDBCursorWithValue IDBFactory IDBVersionChangeEvent
        Geolocation GeolocationPosition Animation KeyframeEffect AnimationTimeline DocumentTimeline
        ScreenOrientation Permissions Clipboard ClipboardItem PerformanceEntry PerformanceMark PerformanceMeasure
        PerformanceNavigationTiming PerformanceResourceTiming Storage StorageManager WebTransport RTCPeerConnection
        RTCDataChannel RTCSessionDescription RTCIceCandidate Location Navigator Screen History Window Worklet
        WakeLock WakeLockSentinel VisualViewport Vibration PointerLock FullscreenEvent ImageCapture
        WebAssembly SharedWorkerGlobalScope DedicatedWorkerGlobalScope WorkerGlobalScope importScripts
        """;

    private const string TestRunner = "assert fail test AssertionError";

    public static readonly HashSet<string> Builtin = Split(EcmaScript, Browser);

    public static readonly HashSet<string> TestOnly = Split(TestRunner);

    private static HashSet<string> Split(params string[] lists)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var list in lists)
        {
            foreach (var n in list.Split((char[]?) null, StringSplitOptions.RemoveEmptyEntries))
            {
                set.Add(n);
            }
        }

        return set;
    }
}
