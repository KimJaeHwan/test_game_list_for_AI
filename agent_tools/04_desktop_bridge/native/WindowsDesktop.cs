using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace DesktopBridge.Native;

internal static class WindowsDesktop
{
    private const int MaximumTitleCharacters = 32_768;
    private const long MaximumCapturePixels = 16_777_216;

    private static readonly object OperationGate = new();
    private static readonly IFrameCaptureBackend FrameCaptureBackend =
        new GdiFrameCaptureBackend();
    private static readonly IInputBackend InputBackend =
        new SendInputBackend();

    private static readonly IReadOnlyDictionary<string, KeySpec> AllowedKeys =
        new Dictionary<string, KeySpec>(StringComparer.Ordinal)
        {
            ["ArrowUp"] = new(0x48, true),
            ["ArrowDown"] = new(0x50, true),
            ["ArrowLeft"] = new(0x4B, true),
            ["ArrowRight"] = new(0x4D, true),
            ["Enter"] = new(0x1C, false),
            ["Tab"] = new(0x0F, false),
            ["Space"] = new(0x39, false),
            ["Shift"] = new(0x2A, false),
            ["KeyA"] = new(0x1E, false),
            ["KeyB"] = new(0x30, false),
            ["KeyC"] = new(0x2E, false),
            ["KeyD"] = new(0x20, false),
            ["KeyE"] = new(0x12, false),
            ["KeyF"] = new(0x21, false),
            ["KeyN"] = new(0x31, false),
            ["KeyR"] = new(0x13, false),
            ["Digit1"] = new(0x02, false),
            ["Digit2"] = new(0x03, false),
            ["Digit3"] = new(0x04, false),
            ["Digit4"] = new(0x05, false),
        };

    public static IReadOnlyList<WindowCandidate> ListWindows()
    {
        lock (OperationGate)
        {
            var windows = new List<WindowCandidate>();
            Exception? callbackFailure = null;

            bool completed = NativeMethods.EnumWindows(
                (hwnd, _) =>
                {
                    try
                    {
                        if (!NativeMethods.IsWindowVisible(hwnd) ||
                            !TryReadCloakedState(hwnd, out bool cloaked) ||
                            cloaked)
                        {
                            return true;
                        }

                        if (!TryReadIdentity(hwnd, out IdentitySnapshot snapshot))
                        {
                            return true;
                        }

                        windows.Add(
                            new WindowCandidate(
                                ReadWindowTitle(hwnd),
                                snapshot.ExecutablePath,
                                snapshot.Identity));
                        return true;
                    }
                    catch (Exception ex)
                    {
                        callbackFailure = ex;
                        return false;
                    }
                },
                0);

            if (!completed || callbackFailure is not null)
            {
                if (callbackFailure is not null)
                {
                    Console.Error.WriteLine(
                        $"window enumeration callback failed: {callbackFailure.GetType().Name}");
                }

                throw new RequestException(
                    "ENUMERATION_FAILED",
                    "Visible windows could not be enumerated.");
            }

            return windows;
        }
    }

    public static TargetIdentity Inspect(nint hwnd)
    {
        lock (OperationGate)
        {
            if (!TryReadIdentity(hwnd, out IdentitySnapshot snapshot))
            {
                throw new RequestException(
                    "INSPECTION_FAILED",
                    "Window identity is unavailable.");
            }

            return snapshot.Identity;
        }
    }

    public static CaptureResult Capture(TargetIdentity binding, CaptureRegion region)
    {
        lock (OperationGate)
        {
            BridgeProtocol.ValidateContainedRegion(region, binding);
            ValidatedTarget target = ValidateBoundWindow(binding);
            ScreenRect screenRegion = ToScreenRect(target.ClientOrigin, region);
            EnsureRegionIsOnDesktop(screenRegion);
            EnsureNotOccluded(target.Hwnd, screenRegion);

            if (NativeMethods.DwmFlush() != 0)
            {
                throw new RequestException(
                    "CAPTURE_FAILED",
                    "Desktop composition could not be synchronized.");
            }

            target = ValidateBoundWindow(binding);
            screenRegion = ToScreenRect(target.ClientOrigin, region);
            EnsureRegionIsOnDesktop(screenRegion);
            EnsureNotOccluded(target.Hwnd, screenRegion);

            long pixelCount = (long)region.Width * region.Height;
            if (pixelCount > MaximumCapturePixels)
            {
                throw new RequestException(
                    "CAPTURE_TOO_LARGE",
                    "Requested capture region is too large.");
            }

            CapturedFrame captured = BackendDispatch.Capture(
                FrameCaptureBackend,
                new ValidatedCaptureRegion(
                    screenRegion.X,
                    screenRegion.Y,
                    screenRegion.Width,
                    screenRegion.Height));

            ValidatedTarget after = ValidateBoundWindow(binding);
            ScreenRect afterRegion = ToScreenRect(after.ClientOrigin, region);
            if (afterRegion != screenRegion)
            {
                throw new RequestException(
                    "WINDOW_STATE_CHANGED",
                    "Window geometry changed during capture.");
            }

            EnsureNotOccluded(after.Hwnd, afterRegion);

            return new CaptureResult(
                Convert.ToBase64String(captured.PngBytes),
                region.Width,
                region.Height,
                captured.BackendId);
        }
    }

    public static DeliveryResult TapKey(TargetIdentity binding, string code)
    {
        if (!TryResolveAllowedKey(code, out ValidatedKeyTap key))
        {
            throw new RequestException(
                "KEY_NOT_ALLOWED",
                "Key code is not allowlisted.");
        }

        lock (OperationGate)
        {
            ValidatedTarget target = ValidateBoundWindow(binding);
            EnsureOperationalState(target.Hwnd);

            return BackendDispatch.TapKey(
                InputBackend,
                key);
        }
    }

    internal static bool TryResolveAllowedKey(
        string code,
        out ValidatedKeyTap key)
    {
        if (AllowedKeys.TryGetValue(code, out KeySpec spec))
        {
            key = new ValidatedKeyTap(spec.ScanCode, spec.Extended);
            return true;
        }

        key = default;
        return false;
    }

    public static DeliveryResult SafeClick(
        TargetIdentity binding,
        CaptureRegion region,
        ClientPoint point)
    {
        lock (OperationGate)
        {
            BridgeProtocol.ValidateContainedRegion(region, binding);
            BridgeProtocol.ValidatePointInRegion(point, region);
            ValidatedTarget target = ValidateBoundWindow(binding);
            Point screenPoint = ToScreenPoint(target.ClientOrigin, point);
            var onePixel = new ScreenRect(screenPoint.X, screenPoint.Y, 1, 1);
            EnsureRegionIsOnDesktop(onePixel);
            EnsureNotOccluded(target.Hwnd, onePixel);
            EnsurePointResolvesToTarget(target.Hwnd, screenPoint);

            EnsureOperationalState(target.Hwnd);
            EnsureGeometryAndOriginUnchanged(binding, target.ClientOrigin);
            EnsurePointResolvesToTarget(target.Hwnd, screenPoint);

            VirtualDesktop desktop = ReadVirtualDesktop();
            int normalizedX = NormalizeAbsoluteCoordinate(
                screenPoint.X,
                desktop.X,
                desktop.Width);
            int normalizedY = NormalizeAbsoluteCoordinate(
                screenPoint.Y,
                desktop.Y,
                desktop.Height);

            return BackendDispatch.Click(
                InputBackend,
                new ValidatedMouseClick(normalizedX, normalizedY));
        }
    }

    private static ValidatedTarget ValidateBoundWindow(TargetIdentity binding)
    {
        nint hwnd = BridgeProtocol.ParseHwnd(binding.Hwnd);
        if (!TryReadIdentity(hwnd, out IdentitySnapshot snapshot))
        {
            throw new RequestException(
                "WINDOW_NOT_FOUND",
                "The bound window is unavailable.");
        }

        if (snapshot.Identity != binding)
        {
            throw new RequestException(
                "IDENTITY_MISMATCH",
                "The current window does not match the pinned identity.");
        }

        EnsureOperationalState(hwnd);
        Point origin = new(0, 0);
        if (!NativeMethods.ClientToScreen(hwnd, ref origin))
        {
            throw new RequestException(
                "WINDOW_STATE_CHANGED",
                "Client coordinates are unavailable.");
        }

        return new ValidatedTarget(hwnd, origin);
    }

    private static void EnsureOperationalState(nint hwnd)
    {
        if (!NativeMethods.IsWindow(hwnd))
        {
            throw new RequestException(
                "WINDOW_NOT_FOUND",
                "The bound window is unavailable.");
        }

        if (!NativeMethods.IsWindowVisible(hwnd) ||
            !TryReadCloakedState(hwnd, out bool cloaked) ||
            cloaked)
        {
            throw new RequestException(
                "WINDOW_NOT_VISIBLE",
                "The bound window is not visible.");
        }

        if (NativeMethods.IsIconic(hwnd))
        {
            throw new RequestException(
                "WINDOW_MINIMIZED",
                "The bound window is minimized.");
        }

        if (NativeMethods.GetForegroundWindow() != hwnd)
        {
            throw new RequestException(
                "WINDOW_NOT_FOREGROUND",
                "The bound window is not the foreground window.");
        }
    }

    private static void EnsureGeometryAndOriginUnchanged(
        TargetIdentity binding,
        Point expectedOrigin)
    {
        nint hwnd = BridgeProtocol.ParseHwnd(binding.Hwnd);
        if (!NativeMethods.GetClientRect(hwnd, out Rect clientRect) ||
            clientRect.Left != 0 ||
            clientRect.Top != 0 ||
            clientRect.Width != binding.ClientWidth ||
            clientRect.Height != binding.ClientHeight)
        {
            throw new RequestException(
                "WINDOW_STATE_CHANGED",
                "Window geometry changed before input delivery.");
        }

        var currentOrigin = new Point(0, 0);
        if (!NativeMethods.ClientToScreen(hwnd, ref currentOrigin) ||
            currentOrigin.X != expectedOrigin.X ||
            currentOrigin.Y != expectedOrigin.Y)
        {
            throw new RequestException(
                "WINDOW_STATE_CHANGED",
                "Window geometry changed before input delivery.");
        }
    }

    private static bool TryReadIdentity(nint hwnd, out IdentitySnapshot snapshot)
    {
        snapshot = null!;
        if (!NativeMethods.IsWindow(hwnd) ||
            NativeMethods.GetAncestor(hwnd, NativeMethods.GaRoot) != hwnd)
        {
            return false;
        }

        _ = NativeMethods.GetWindowThreadProcessId(hwnd, out uint firstProcessId);
        if (firstProcessId == 0 || firstProcessId > int.MaxValue)
        {
            return false;
        }

        using var process = NativeMethods.OpenProcess(
            NativeMethods.ProcessQueryLimitedInformation,
            inheritHandle: false,
            firstProcessId);
        if (process.IsInvalid)
        {
            return false;
        }

        var pathBuffer = new StringBuilder(32_768);
        uint pathLength = (uint)pathBuffer.Capacity;
        if (!NativeMethods.QueryFullProcessImageNameW(
                process,
                0,
                pathBuffer,
                ref pathLength) ||
            pathLength == 0)
        {
            return false;
        }

        if (!NativeMethods.GetProcessTimes(
                process,
                out FileTime creationTime,
                out _,
                out _,
                out _))
        {
            return false;
        }

        string executablePath = pathBuffer.ToString(0, checked((int)pathLength));
        string executableHash;
        try
        {
            using var executable = new FileStream(
                executablePath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                bufferSize: 128 * 1024,
                FileOptions.SequentialScan);
            executableHash = Convert.ToHexString(SHA256.HashData(executable))
                .ToLowerInvariant();
        }
        catch (Exception ex) when (
            ex is IOException or UnauthorizedAccessException or
            NotSupportedException or ArgumentException)
        {
            return false;
        }

        if (!NativeMethods.GetClientRect(hwnd, out Rect clientRect) ||
            clientRect.Width <= 0 ||
            clientRect.Height <= 0)
        {
            return false;
        }

        _ = NativeMethods.GetWindowThreadProcessId(hwnd, out uint secondProcessId);
        if (secondProcessId != firstProcessId || !NativeMethods.IsWindow(hwnd))
        {
            return false;
        }

        string startTime;
        try
        {
            startTime = DateTime.FromFileTimeUtc(creationTime.ToLong())
                .ToString("O", CultureInfo.InvariantCulture);
        }
        catch (ArgumentOutOfRangeException)
        {
            return false;
        }

        var identity = new TargetIdentity(
            HwndToDecimalString(hwnd),
            (int)firstProcessId,
            startTime,
            executableHash,
            clientRect.Width,
            clientRect.Height);
        snapshot = new IdentitySnapshot(identity, executablePath);
        return true;
    }

    private static string ReadWindowTitle(nint hwnd)
    {
        int reportedLength = NativeMethods.GetWindowTextLengthW(hwnd);
        int capacity = Math.Clamp(reportedLength + 1, 1, MaximumTitleCharacters + 1);
        var title = new StringBuilder(capacity);
        int copied = NativeMethods.GetWindowTextW(hwnd, title, capacity);
        return copied > 0 ? title.ToString(0, copied) : string.Empty;
    }

    private static string HwndToDecimalString(nint hwnd)
    {
        ulong raw = IntPtr.Size == 8
            ? unchecked((ulong)hwnd.ToInt64())
            : unchecked((uint)hwnd.ToInt32());
        return raw.ToString(CultureInfo.InvariantCulture);
    }

    private static bool TryReadCloakedState(nint hwnd, out bool cloaked)
    {
        int result = NativeMethods.DwmGetWindowAttribute(
            hwnd,
            NativeMethods.DwmwaCloaked,
            out int value,
            sizeof(int));
        cloaked = value != 0;
        return result >= 0;
    }

    private static ScreenRect ToScreenRect(Point clientOrigin, CaptureRegion region)
    {
        try
        {
            return new ScreenRect(
                checked(clientOrigin.X + region.X),
                checked(clientOrigin.Y + region.Y),
                region.Width,
                region.Height);
        }
        catch (OverflowException)
        {
            throw new RequestException(
                "INVALID_REGION",
                "Region cannot be represented in desktop coordinates.");
        }
    }

    private static Point ToScreenPoint(Point clientOrigin, ClientPoint point)
    {
        try
        {
            return new Point(
                checked(clientOrigin.X + point.X),
                checked(clientOrigin.Y + point.Y));
        }
        catch (OverflowException)
        {
            throw new RequestException(
                "INVALID_POINT",
                "Point cannot be represented in desktop coordinates.");
        }
    }

    private static VirtualDesktop ReadVirtualDesktop()
    {
        int x = NativeMethods.GetSystemMetrics(NativeMethods.SmXVirtualScreen);
        int y = NativeMethods.GetSystemMetrics(NativeMethods.SmYVirtualScreen);
        int width = NativeMethods.GetSystemMetrics(NativeMethods.SmCxVirtualScreen);
        int height = NativeMethods.GetSystemMetrics(NativeMethods.SmCyVirtualScreen);
        if (width <= 0 || height <= 0)
        {
            throw new RequestException(
                "DESKTOP_UNAVAILABLE",
                "Virtual desktop geometry is unavailable.");
        }

        return new VirtualDesktop(x, y, width, height);
    }

    private static void EnsureRegionIsOnDesktop(ScreenRect region)
    {
        VirtualDesktop desktop = ReadVirtualDesktop();
        long regionRight = (long)region.X + region.Width;
        long regionBottom = (long)region.Y + region.Height;
        long desktopRight = (long)desktop.X + desktop.Width;
        long desktopBottom = (long)desktop.Y + desktop.Height;
        if (region.X < desktop.X ||
            region.Y < desktop.Y ||
            regionRight > desktopRight ||
            regionBottom > desktopBottom)
        {
            throw new RequestException(
                "REGION_NOT_COMPOSITED",
                "The requested client region is not fully on the virtual desktop.");
        }
    }

    private static void EnsureNotOccluded(nint target, ScreenRect captureRect)
    {
        bool foundTarget = false;
        bool occluded = false;
        Exception? callbackFailure = null;

        _ = NativeMethods.EnumWindows(
            (candidate, _) =>
            {
                try
                {
                    if (candidate == target)
                    {
                        foundTarget = true;
                        return false;
                    }

                    if (!NativeMethods.IsWindowVisible(candidate) ||
                        NativeMethods.IsIconic(candidate) ||
                        !NativeMethods.GetWindowRect(candidate, out Rect candidateRect))
                    {
                        return true;
                    }

                    if (TryReadCloakedState(candidate, out bool cloaked) && cloaked)
                    {
                        return true;
                    }

                    if (Intersects(captureRect, candidateRect))
                    {
                        occluded = true;
                        return false;
                    }

                    return true;
                }
                catch (Exception ex)
                {
                    callbackFailure = ex;
                    return false;
                }
            },
            0);

        if (callbackFailure is not null)
        {
            Console.Error.WriteLine(
                $"occlusion check failed: {callbackFailure.GetType().Name}");
            throw new RequestException(
                "OCCLUSION_UNKNOWN",
                "The capture region could not be verified as unobscured.");
        }

        if (occluded)
        {
            throw new RequestException(
                "WINDOW_OCCLUDED",
                "The bound client region is obscured.");
        }

        if (!foundTarget)
        {
            throw new RequestException(
                "WINDOW_STATE_CHANGED",
                "The bound window left the visible window stack.");
        }
    }

    private static bool Intersects(ScreenRect first, Rect second)
    {
        long firstRight = (long)first.X + first.Width;
        long firstBottom = (long)first.Y + first.Height;
        return first.X < second.Right &&
            firstRight > second.Left &&
            first.Y < second.Bottom &&
            firstBottom > second.Top;
    }

    private static void EnsurePointResolvesToTarget(nint target, Point screenPoint)
    {
        nint hit = NativeMethods.WindowFromPoint(screenPoint);
        if (hit == 0 ||
            NativeMethods.GetAncestor(hit, NativeMethods.GaRoot) != target)
        {
            throw new RequestException(
                "CLICK_TARGET_MISMATCH",
                "The safe point does not currently resolve to the bound window.");
        }
    }

    private static int NormalizeAbsoluteCoordinate(int coordinate, int origin, int span)
    {
        if (span <= 1)
        {
            return 0;
        }

        long offset = (long)coordinate - origin;
        return checked((int)((offset * 65_535L + (span - 1L) / 2L) / (span - 1L)));
    }

    private sealed record IdentitySnapshot(
        TargetIdentity Identity,
        string ExecutablePath);

    private readonly record struct ValidatedTarget(nint Hwnd, Point ClientOrigin);

    private readonly record struct ScreenRect(int X, int Y, int Width, int Height);

    private readonly record struct VirtualDesktop(int X, int Y, int Width, int Height);

    private readonly record struct KeySpec(ushort ScanCode, bool Extended);
}
