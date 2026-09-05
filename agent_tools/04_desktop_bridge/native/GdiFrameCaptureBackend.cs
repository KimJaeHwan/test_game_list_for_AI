using System.Runtime.InteropServices;

namespace DesktopBridge.Native;

internal sealed class GdiFrameCaptureBackend : IFrameCaptureBackend
{
    public string BackendId => "gdi-composited-screen/v1";

    public byte[] Capture(ValidatedCaptureRegion region)
    {
        nint screenDc = NativeMethods.GetDC(0);
        if (screenDc == 0)
        {
            throw new InvalidOperationException(
                "Desktop pixels are unavailable.");
        }

        nint memoryDc = 0;
        nint bitmap = 0;
        nint previousObject = 0;
        try
        {
            memoryDc = NativeMethods.CreateCompatibleDC(screenDc);
            if (memoryDc == 0)
            {
                throw new InvalidOperationException(
                    "A capture surface could not be created.");
            }

            var bitmapInfo = new BitmapInfo
            {
                Header = new BitmapInfoHeader
                {
                    Size = (uint)Marshal.SizeOf<BitmapInfoHeader>(),
                    Width = region.Width,
                    Height = -region.Height,
                    Planes = 1,
                    BitCount = 32,
                    Compression = NativeMethods.BiRgb,
                    SizeImage = checked((uint)((long)region.Width * region.Height * 4)),
                },
            };

            bitmap = NativeMethods.CreateDIBSection(
                screenDc,
                ref bitmapInfo,
                NativeMethods.DibRgbColors,
                out nint bits,
                0,
                0);
            if (bitmap == 0 || bits == 0)
            {
                throw new InvalidOperationException(
                    "A capture bitmap could not be created.");
            }

            previousObject = NativeMethods.SelectObject(memoryDc, bitmap);
            if (previousObject == 0 || previousObject == new nint(-1))
            {
                throw new InvalidOperationException(
                    "The capture bitmap could not be selected.");
            }

            if (!NativeMethods.BitBlt(
                    memoryDc,
                    0,
                    0,
                    region.Width,
                    region.Height,
                    screenDc,
                    region.ScreenX,
                    region.ScreenY,
                    NativeMethods.SrcCopy | NativeMethods.CaptureBlt) ||
                !NativeMethods.GdiFlush())
            {
                throw new InvalidOperationException(
                    "Desktop pixels could not be captured.");
            }

            return PngEncoder.EncodeBgra32(bits, region.Width, region.Height);
        }
        finally
        {
            if (memoryDc != 0 &&
                previousObject != 0 &&
                previousObject != new nint(-1))
            {
                _ = NativeMethods.SelectObject(memoryDc, previousObject);
            }

            if (bitmap != 0)
            {
                _ = NativeMethods.DeleteObject(bitmap);
            }

            if (memoryDc != 0)
            {
                _ = NativeMethods.DeleteDC(memoryDc);
            }

            _ = NativeMethods.ReleaseDC(0, screenDc);
        }
    }
}
