using System.Text;

namespace DesktopBridge.Native;

internal static class Program
{
    private const int MaxRequestCharacters = 1_048_576;

    public static async Task<int> Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
        Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

        if (args.Length == 1 && string.Equals(args[0], "--self-test", StringComparison.Ordinal))
        {
            return SelfTests.Run(Console.Error);
        }

        if (args.Length != 0)
        {
            Console.Error.WriteLine("desktop-bridge-native accepts NDJSON on stdin; the only command-line option is --self-test.");
            return 64;
        }

        _ = NativeMethods.SetProcessDpiAwarenessContext(NativeMethods.DpiAwarenessContextPerMonitorAwareV2);

        using Stream inputStream = Console.OpenStandardInput();
        using var input = new StreamReader(
            inputStream,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true),
            detectEncodingFromByteOrderMarks: false,
            bufferSize: 4096,
            leaveOpen: false);
        using Stream outputStream = Console.OpenStandardOutput();
        using var output = new StreamWriter(
            outputStream,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            bufferSize: 4096,
            leaveOpen: false)
        {
            AutoFlush = true,
            NewLine = "\n",
        };

        while (true)
        {
            string? line;
            try
            {
                line = await input.ReadLineAsync().ConfigureAwait(false);
            }
            catch (DecoderFallbackException ex)
            {
                Console.Error.WriteLine($"stdin decoding failed: {ex.GetType().Name}");
                await output.WriteLineAsync(
                    ProtocolResponse.Failure(null, "INVALID_JSON", "Request is not valid UTF-8 JSON."))
                    .ConfigureAwait(false);
                return 65;
            }

            if (line is null)
            {
                break;
            }

            string response;
            if (line.Length > MaxRequestCharacters)
            {
                response = ProtocolResponse.Failure(null, "INVALID_REQUEST", "Request line is too large.");
            }
            else
            {
                try
                {
                    response = BridgeProtocol.ProcessLine(line);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"request failed internally: {ex.GetType().Name}: {ex.Message}");
                    response = ProtocolResponse.Failure(
                        null,
                        "INTERNAL_ERROR",
                        "The native bridge could not process the request.");
                }
            }

            await output.WriteLineAsync(response).ConfigureAwait(false);
        }

        return 0;
    }
}
