using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace DesktopBridge.Native;

internal static class NativeMethods
{
    public static readonly nint DpiAwarenessContextPerMonitorAwareV2 = new(-4);

    public const uint ProcessQueryLimitedInformation = 0x1000;
    public const uint GaRoot = 2;
    public const int DwmwaCloaked = 14;

    public const int SmXVirtualScreen = 76;
    public const int SmYVirtualScreen = 77;
    public const int SmCxVirtualScreen = 78;
    public const int SmCyVirtualScreen = 79;

    public const uint DibRgbColors = 0;
    public const uint BiRgb = 0;
    public const uint SrcCopy = 0x00CC0020;
    public const uint CaptureBlt = 0x40000000;

    public const uint InputMouse = 0;
    public const uint InputKeyboard = 1;
    public const uint KeyeventfExtendedKey = 0x0001;
    public const uint KeyeventfKeyup = 0x0002;
    public const uint MouseeventfMove = 0x0001;
    public const uint MouseeventfLeftdown = 0x0002;
    public const uint MouseeventfLeftup = 0x0004;
    public const uint MouseeventfVirtualdesk = 0x4000;
    public const uint MouseeventfAbsolute = 0x8000;

    internal delegate bool EnumWindowsProc(nint hwnd, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc callback, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(nint hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(nint hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(nint hwnd);

    [DllImport("user32.dll")]
    public static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern nint GetAncestor(nint hwnd, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(nint hwnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowTextLengthW(nint hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowTextW(nint hwnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetClientRect(nint hwnd, out Rect rect);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(nint hwnd, out Rect rect);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ClientToScreen(nint hwnd, ref Point point);

    [DllImport("user32.dll")]
    public static extern nint WindowFromPoint(Point point);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern nint GetDC(nint hwnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(nint hwnd, nint dc);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(
        uint inputCount,
        [In] Input[] inputs,
        int inputSize);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetProcessDpiAwarenessContext(nint dpiContext);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern SafeProcessHandle OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool QueryFullProcessImageNameW(
        SafeProcessHandle process,
        uint flags,
        StringBuilder executablePath,
        ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetProcessTimes(
        SafeProcessHandle process,
        out FileTime creationTime,
        out FileTime exitTime,
        out FileTime kernelTime,
        out FileTime userTime);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern nint CreateCompatibleDC(nint dc);

    [DllImport("gdi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeleteDC(nint dc);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern nint CreateDIBSection(
        nint dc,
        ref BitmapInfo bitmapInfo,
        uint usage,
        out nint bits,
        nint section,
        uint offset);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern nint SelectObject(nint dc, nint gdiObject);

    [DllImport("gdi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeleteObject(nint gdiObject);

    [DllImport("gdi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool BitBlt(
        nint destinationDc,
        int destinationX,
        int destinationY,
        int width,
        int height,
        nint sourceDc,
        int sourceX,
        int sourceY,
        uint rasterOperation);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GdiFlush();

    [DllImport("dwmapi.dll")]
    public static extern int DwmFlush();

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(
        nint hwnd,
        int attribute,
        out int value,
        int valueSize);
}

[StructLayout(LayoutKind.Sequential)]
internal struct Point
{
    public int X;
    public int Y;

    public Point(int x, int y)
    {
        X = x;
        Y = y;
    }
}

[StructLayout(LayoutKind.Sequential)]
internal struct Rect
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;

    public readonly int Width => Right - Left;

    public readonly int Height => Bottom - Top;
}

[StructLayout(LayoutKind.Sequential)]
internal struct FileTime
{
    public uint LowDateTime;
    public uint HighDateTime;

    public readonly long ToLong()
    {
        return unchecked((long)(((ulong)HighDateTime << 32) | LowDateTime));
    }
}

[StructLayout(LayoutKind.Sequential)]
internal struct BitmapInfoHeader
{
    public uint Size;
    public int Width;
    public int Height;
    public ushort Planes;
    public ushort BitCount;
    public uint Compression;
    public uint SizeImage;
    public int XPelsPerMeter;
    public int YPelsPerMeter;
    public uint ClrUsed;
    public uint ClrImportant;
}

[StructLayout(LayoutKind.Sequential)]
internal struct BitmapInfo
{
    public BitmapInfoHeader Header;
}

[StructLayout(LayoutKind.Sequential)]
internal struct Input
{
    public uint Type;
    public InputUnion Data;
}

[StructLayout(LayoutKind.Explicit)]
internal struct InputUnion
{
    [FieldOffset(0)]
    public MouseInput Mouse;

    [FieldOffset(0)]
    public KeyboardInput Keyboard;

    [FieldOffset(0)]
    public HardwareInput Hardware;
}

[StructLayout(LayoutKind.Sequential)]
internal struct MouseInput
{
    public int Dx;
    public int Dy;
    public uint MouseData;
    public uint Flags;
    public uint Time;
    public nuint ExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
internal struct KeyboardInput
{
    public ushort VirtualKey;
    public ushort ScanCode;
    public uint Flags;
    public uint Time;
    public nuint ExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
internal struct HardwareInput
{
    public uint Message;
    public ushort ParameterLow;
    public ushort ParameterHigh;
}
