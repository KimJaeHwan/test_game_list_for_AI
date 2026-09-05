using System.Buffers.Binary;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;

namespace DesktopBridge.Native;

internal static class PngEncoder
{
    private static readonly byte[] Signature =
    {
        137, 80, 78, 71, 13, 10, 26, 10,
    };

    private static readonly uint[] CrcTable = BuildCrcTable();

    public static byte[] EncodeBgra32(nint pixels, int width, int height)
    {
        int byteCount = checked(width * height * 4);
        var bgra = new byte[byteCount];
        Marshal.Copy(pixels, bgra, 0, byteCount);
        return EncodeBgra32(bgra, width, height);
    }

    internal static byte[] EncodeBgra32(
        ReadOnlySpan<byte> bgra,
        int width,
        int height)
    {
        if (width <= 0 || height <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(width),
                "PNG dimensions must be positive.");
        }

        int sourceStride = checked(width * 4);
        if (bgra.Length != checked(sourceStride * height))
        {
            throw new ArgumentException(
                "BGRA byte count does not match dimensions.",
                nameof(bgra));
        }

        using var png = new MemoryStream();
        png.Write(Signature);

        Span<byte> header = stackalloc byte[13];
        BinaryPrimitives.WriteUInt32BigEndian(header[..4], (uint)width);
        BinaryPrimitives.WriteUInt32BigEndian(header.Slice(4, 4), (uint)height);
        header[8] = 8;
        header[9] = 2;
        header[10] = 0;
        header[11] = 0;
        header[12] = 0;
        WriteChunk(png, "IHDR"u8, header);

        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(
                   compressed,
                   CompressionLevel.Fastest,
                   leaveOpen: true))
        {
            var row = new byte[checked(width * 3 + 1)];
            for (int y = 0; y < height; y++)
            {
                row[0] = 0;
                int sourceOffset = checked(y * sourceStride);
                int destinationOffset = 1;
                for (int x = 0; x < width; x++)
                {
                    int pixelOffset = checked(sourceOffset + x * 4);
                    row[destinationOffset++] = bgra[pixelOffset + 2];
                    row[destinationOffset++] = bgra[pixelOffset + 1];
                    row[destinationOffset++] = bgra[pixelOffset];
                }

                zlib.Write(row);
            }
        }

        WriteChunk(png, "IDAT"u8, compressed.GetBuffer().AsSpan(0, checked((int)compressed.Length)));
        WriteChunk(png, "IEND"u8, ReadOnlySpan<byte>.Empty);
        return png.ToArray();
    }

    private static void WriteChunk(
        Stream destination,
        ReadOnlySpan<byte> type,
        ReadOnlySpan<byte> data)
    {
        if (type.Length != 4)
        {
            throw new ArgumentException(
                "PNG chunk type must be four bytes.",
                nameof(type));
        }

        Span<byte> integer = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(integer, checked((uint)data.Length));
        destination.Write(integer);
        destination.Write(type);
        destination.Write(data);

        uint crc = ComputeCrc(type, data);
        BinaryPrimitives.WriteUInt32BigEndian(integer, crc);
        destination.Write(integer);
    }

    private static uint ComputeCrc(
        ReadOnlySpan<byte> first,
        ReadOnlySpan<byte> second)
    {
        uint crc = uint.MaxValue;
        foreach (byte value in first)
        {
            crc = CrcTable[(crc ^ value) & 0xff] ^ (crc >> 8);
        }

        foreach (byte value in second)
        {
            crc = CrcTable[(crc ^ value) & 0xff] ^ (crc >> 8);
        }

        return crc ^ uint.MaxValue;
    }

    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (uint value = 0; value < table.Length; value++)
        {
            uint remainder = value;
            for (int bit = 0; bit < 8; bit++)
            {
                remainder = (remainder & 1) != 0
                    ? 0xedb88320U ^ (remainder >> 1)
                    : remainder >> 1;
            }

            table[value] = remainder;
        }

        return table;
    }
}
