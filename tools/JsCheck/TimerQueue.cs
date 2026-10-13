using Jint.Native;

namespace JsCheck;

internal enum TimerKind
{
    Timeout,
    Interval,
    AnimationFrame,
}

internal sealed class VirtualTimer
{
    public int Id;
    public TimerKind Kind;
    public JsValue Callback = JsValue.Undefined;
    public JsValue[] Args = Array.Empty<JsValue>();
    public double Delay;
    public double Due;
    public int Nesting;
    public bool Cancelled;
}

/// <summary>
/// Virtual clock + timer queue. Nothing ever sleeps: when the JS job queue is empty the runner pops the
/// earliest timer, jumps the clock to its due time and runs it. Ties run in scheduling order.
/// Follows the HTML timer rules that matter for determinism: negative/NaN delays become 0, and timers
/// nested more than 5 levels deep are clamped to at least 4 ms (so setTimeout(0) loops still advance time).
/// </summary>
internal sealed class TimerQueue
{
    public const double FrameMs = 1000.0 / 60.0;

    private readonly PriorityQueue<VirtualTimer, (double Due, long Seq)> _queue = new();
    private readonly Dictionary<int, VirtualTimer> _active = new();
    private int _nextId = 1;
    private long _seq;

    /// <summary>Virtual milliseconds since the run started.</summary>
    public double Now { get; private set; }

    /// <summary>Nesting level of the timer callback currently running (0 outside timer callbacks).</summary>
    public int CurrentNesting { get; set; }

    public long Fired { get; private set; }

    public int ActiveCount => _active.Count;

    public IEnumerable<VirtualTimer> Active => _active.Values;

    public int Schedule(TimerKind kind, JsValue callback, JsValue[] args, double delay)
    {
        if (double.IsNaN(delay) || delay < 0 || double.IsNegativeInfinity(delay))
        {
            delay = 0;
        }

        // Browsers store the delay in a signed 32-bit int; larger values overflow to "immediately".
        if (delay > int.MaxValue)
        {
            delay = 0;
        }

        // HTML timer initialization steps: the clamp looks at the nesting level of the task that is running
        // now (0 outside timer tasks); the new timer's task gets that level + 1.
        var level = CurrentNesting;
        var timer = new VirtualTimer
        {
            Id = _nextId++,
            Kind = kind,
            Callback = callback,
            Args = args,
            Delay = delay,
            Nesting = level + 1,
        };

        if (kind == TimerKind.AnimationFrame)
        {
            timer.Due = NextFrame(Now);
        }
        else
        {
            timer.Due = Now + Clamp(delay, level);
        }

        _active[timer.Id] = timer;
        _queue.Enqueue(timer, (timer.Due, _seq++));
        return timer.Id;
    }

    private static double Clamp(double delay, int level) => level > 5 && delay < 4 ? 4 : delay;

    private static double NextFrame(double now)
    {
        var frame = Math.Floor(now / FrameMs + 1e-9) + 1;
        return frame * FrameMs;
    }

    public void Clear(int id)
    {
        if (_active.Remove(id, out var timer))
        {
            timer.Cancelled = true;
        }
    }

    /// <summary>Earliest live timer without removing it.</summary>
    public bool TryPeek(out VirtualTimer timer)
    {
        while (_queue.TryPeek(out timer!, out _))
        {
            if (!timer.Cancelled)
            {
                return true;
            }

            _queue.Dequeue();
        }

        timer = null!;
        return false;
    }

    /// <summary>Removes the earliest live timer and advances the clock to its due time.</summary>
    public VirtualTimer Take()
    {
        if (!TryPeek(out var timer))
        {
            throw new InvalidOperationException("No timers pending");
        }

        _queue.Dequeue();
        if (timer.Due > Now)
        {
            Now = timer.Due;
        }

        Fired++;
        if (timer.Kind != TimerKind.Interval)
        {
            _active.Remove(timer.Id);
        }

        return timer;
    }

    /// <summary>Re-arms an interval after its callback ran (unless it was cleared meanwhile).</summary>
    public void Rearm(VirtualTimer timer)
    {
        if (timer.Cancelled || timer.Kind != TimerKind.Interval)
        {
            return;
        }

        // Re-running the initialization steps from inside the interval's own task.
        timer.Due = Now + Clamp(timer.Delay, timer.Nesting);
        timer.Nesting++;
        _queue.Enqueue(timer, (timer.Due, _seq++));
    }
}
