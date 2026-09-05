using System.Buffers;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace DesktopBridge.Native;

internal static class BridgeProtocol
{
    private static readonly JsonDocumentOptions DocumentOptions = new()
    {
        AllowTrailingCommas = false,
        CommentHandling = JsonCommentHandling.Disallow,
        MaxDepth = 16,
    };

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    public static string ProcessLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return ProtocolResponse.Failure(null, "INVALID_JSON", "Request must be a JSON object.");
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(line, DocumentOptions);
        }
        catch (JsonException)
        {
            return ProtocolResponse.Failure(null, "INVALID_JSON", "Request must be a JSON object.");
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            JsonElement? responseId = TryExtractResponseId(root);

            try
            {
                if (root.ValueKind != JsonValueKind.Object)
                {
                    throw new RequestException("INVALID_REQUEST", "Request must be a JSON object.");
                }

                EnsureNoDuplicateProperties(root, "request");
                JsonElement id = RequireProperty(root, "id");
                if (id.ValueKind is not JsonValueKind.String and not JsonValueKind.Number)
                {
                    throw new RequestException("INVALID_REQUEST", "id must be a string or number.");
                }

                JsonElement opElement = RequireProperty(root, "op");
                if (opElement.ValueKind != JsonValueKind.String)
                {
                    throw new RequestException("INVALID_REQUEST", "op must be a string.");
                }

                string op = opElement.GetString()!;
                object result = op switch
                {
                    "listWindows" => ProcessListWindows(root),
                    "inspect" => ProcessInspect(root),
                    "capture" => ProcessCapture(root),
                    "tapKey" => ProcessTapKey(root),
                    "safeClick" => ProcessSafeClick(root),
                    _ => throw new RequestException("UNSUPPORTED_OP", "Operation is not supported."),
                };

                return ProtocolResponse.Success(id, result, SerializerOptions);
            }
            catch (RequestException ex)
            {
                return ProtocolResponse.Failure(responseId, ex.Code, ex.Message);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"request failed internally: {ex.GetType().Name}: {ex.Message}");
                return ProtocolResponse.Failure(
                    responseId,
                    "INTERNAL_ERROR",
                    "The native bridge could not process the request.");
            }
        }
    }

    private static object ProcessListWindows(JsonElement request)
    {
        RequireExactProperties(request, "request", "id", "op");
        return WindowsDesktop.ListWindows();
    }

    private static object ProcessInspect(JsonElement request)
    {
        RequireExactProperties(request, "request", "id", "op", "hwnd");
        string hwndText = RequireString(request, "hwnd");
        nint hwnd = ParseHwnd(hwndText);
        return WindowsDesktop.Inspect(hwnd);
    }

    private static object ProcessCapture(JsonElement request)
    {
        RequireExactProperties(request, "request", "id", "op", "binding", "region");
        TargetIdentity binding = ParseBinding(RequireProperty(request, "binding"));
        CaptureRegion region = ParseRegion(RequireProperty(request, "region"));
        ValidateContainedRegion(region, binding);
        return WindowsDesktop.Capture(binding, region);
    }

    private static object ProcessTapKey(JsonElement request)
    {
        RequireExactProperties(request, "request", "id", "op", "binding", "code");
        TargetIdentity binding = ParseBinding(RequireProperty(request, "binding"));
        string code = RequireString(request, "code");
        return WindowsDesktop.TapKey(binding, code);
    }

    private static object ProcessSafeClick(JsonElement request)
    {
        RequireExactProperties(request, "request", "id", "op", "binding", "region", "point");
        TargetIdentity binding = ParseBinding(RequireProperty(request, "binding"));
        CaptureRegion region = ParseRegion(RequireProperty(request, "region"));
        ClientPoint point = ParsePoint(RequireProperty(request, "point"));
        ValidateContainedRegion(region, binding);
        ValidatePointInRegion(point, region);
        return WindowsDesktop.SafeClick(binding, region, point);
    }

    internal static TargetIdentity ParseBinding(JsonElement element)
    {
        RequireObject(element, "binding");
        RequireExactProperties(
            element,
            "binding",
            "hwnd",
            "pid",
            "processStartTimeUtc",
            "executableSha256",
            "clientWidth",
            "clientHeight");

        string hwndText = RequireString(element, "hwnd");
        _ = ParseHwnd(hwndText);
        int pid = RequireInt32(element, "pid");
        string startTime = RequireString(element, "processStartTimeUtc");
        string sha = RequireString(element, "executableSha256");
        int clientWidth = RequireInt32(element, "clientWidth");
        int clientHeight = RequireInt32(element, "clientHeight");

        if (pid <= 0)
        {
            throw new RequestException("INVALID_REQUEST", "binding.pid must be positive.");
        }

        if (!DateTimeOffset.TryParse(
                startTime,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out _))
        {
            throw new RequestException(
                "INVALID_REQUEST",
                "binding.processStartTimeUtc must be ISO-8601.");
        }

        if (sha.Length != 64 ||
            sha.Any(static c => c is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
        {
            throw new RequestException(
                "INVALID_REQUEST",
                "binding.executableSha256 must be lowercase SHA-256 hex.");
        }

        if (clientWidth <= 0 || clientHeight <= 0)
        {
            throw new RequestException(
                "INVALID_REQUEST",
                "binding client dimensions must be positive.");
        }

        return new TargetIdentity(
            hwndText,
            pid,
            startTime,
            sha,
            clientWidth,
            clientHeight);
    }

    internal static CaptureRegion ParseRegion(JsonElement element)
    {
        RequireObject(element, "region");
        RequireExactProperties(element, "region", "x", "y", "width", "height");
        var region = new CaptureRegion(
            RequireInt32(element, "x"),
            RequireInt32(element, "y"),
            RequireInt32(element, "width"),
            RequireInt32(element, "height"));
        if (region.Width <= 0 || region.Height <= 0)
        {
            throw new RequestException(
                "INVALID_REGION",
                "Region dimensions must be positive.");
        }

        return region;
    }

    internal static ClientPoint ParsePoint(JsonElement element)
    {
        RequireObject(element, "point");
        RequireExactProperties(element, "point", "x", "y");
        return new ClientPoint(
            RequireInt32(element, "x"),
            RequireInt32(element, "y"));
    }

    internal static void ValidateContainedRegion(CaptureRegion region, TargetIdentity binding)
    {
        long right = (long)region.X + region.Width;
        long bottom = (long)region.Y + region.Height;
        if (region.X < 0 ||
            region.Y < 0 ||
            right > binding.ClientWidth ||
            bottom > binding.ClientHeight)
        {
            throw new RequestException(
                "INVALID_REGION",
                "Region must be fully contained in the bound client rectangle.");
        }
    }

    internal static void ValidatePointInRegion(ClientPoint point, CaptureRegion region)
    {
        long right = (long)region.X + region.Width;
        long bottom = (long)region.Y + region.Height;
        if (point.X < region.X ||
            point.Y < region.Y ||
            point.X >= right ||
            point.Y >= bottom)
        {
            throw new RequestException(
                "INVALID_POINT",
                "Point must lie inside the bound region.");
        }
    }

    internal static nint ParseHwnd(string value)
    {
        if (value.Length == 0 ||
            value.Length > 20 ||
            value[0] == '0' && value.Length != 1 ||
            value.Any(static c => c is < '0' or > '9') ||
            !ulong.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out ulong raw) ||
            raw == 0 ||
            IntPtr.Size == 4 && raw > uint.MaxValue)
        {
            throw new RequestException(
                "INVALID_REQUEST",
                "hwnd must be a non-zero canonical decimal string.");
        }

        return unchecked((nint)(long)raw);
    }

    private static JsonElement RequireProperty(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out JsonElement value))
        {
            throw new RequestException(
                "INVALID_REQUEST",
                $"Missing required field: {propertyName}.");
        }

        return value;
    }

    private static string RequireString(JsonElement element, string propertyName)
    {
        JsonElement value = RequireProperty(element, propertyName);
        if (value.ValueKind != JsonValueKind.String)
        {
            throw new RequestException(
                "INVALID_REQUEST",
                $"{propertyName} must be a string.");
        }

        return value.GetString()!;
    }

    private static int RequireInt32(JsonElement element, string propertyName)
    {
        JsonElement value = RequireProperty(element, propertyName);
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out int result))
        {
            throw new RequestException(
                "INVALID_REQUEST",
                $"{propertyName} must be a 32-bit integer.");
        }

        return result;
    }

    private static void RequireObject(JsonElement element, string label)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            throw new RequestException(
                "INVALID_REQUEST",
                $"{label} must be an object.");
        }

        EnsureNoDuplicateProperties(element, label);
    }

    private static void EnsureNoDuplicateProperties(JsonElement element, string label)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in element.EnumerateObject())
        {
            if (!seen.Add(property.Name))
            {
                throw new RequestException(
                    "INVALID_REQUEST",
                    $"{label} contains a duplicate field.");
            }
        }
    }

    private static void RequireExactProperties(
        JsonElement element,
        string label,
        params string[] propertyNames)
    {
        var expected = new HashSet<string>(propertyNames, StringComparer.Ordinal);
        int count = 0;
        foreach (JsonProperty property in element.EnumerateObject())
        {
            count++;
            if (!expected.Contains(property.Name))
            {
                throw new RequestException(
                    "INVALID_REQUEST",
                    $"{label} contains an unknown field.");
            }
        }

        if (count != expected.Count)
        {
            string? missing = propertyNames.FirstOrDefault(
                name => !element.TryGetProperty(name, out _));
            throw new RequestException(
                "INVALID_REQUEST",
                $"Missing required field: {missing ?? "unknown"}.");
        }
    }

    private static JsonElement? TryExtractResponseId(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        JsonElement? id = null;
        int count = 0;
        foreach (JsonProperty property in root.EnumerateObject())
        {
            if (property.NameEquals("id"))
            {
                id = property.Value.Clone();
                count++;
            }
        }

        return count == 1 ? id : null;
    }
}

internal static class ProtocolResponse
{
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Indented = false,
        SkipValidation = false,
    };

    public static string Success(
        JsonElement id,
        object result,
        JsonSerializerOptions serializerOptions)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WritePropertyName("id");
            id.WriteTo(writer);
            writer.WriteBoolean("ok", true);
            writer.WritePropertyName("result");
            JsonSerializer.Serialize(
                writer,
                result,
                result.GetType(),
                serializerOptions);
            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    public static string Failure(JsonElement? id, string code, string message)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WritePropertyName("id");
            if (id.HasValue)
            {
                id.Value.WriteTo(writer);
            }
            else
            {
                writer.WriteNullValue();
            }

            writer.WriteBoolean("ok", false);
            writer.WritePropertyName("error");
            writer.WriteStartObject();
            writer.WriteString("code", code);
            writer.WriteString("message", message);
            writer.WriteEndObject();
            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }
}

internal sealed class RequestException : Exception
{
    public RequestException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    public string Code { get; }
}

internal sealed record TargetIdentity(
    string Hwnd,
    int Pid,
    string ProcessStartTimeUtc,
    string ExecutableSha256,
    int ClientWidth,
    int ClientHeight);

internal sealed record WindowCandidate(
    string Title,
    string ExecutablePath,
    TargetIdentity Identity);

internal sealed record CaptureRegion(int X, int Y, int Width, int Height);

internal sealed record ClientPoint(int X, int Y);

internal sealed record CaptureResult(
    string PngBase64,
    int Width,
    int Height,
    string CaptureBackend);

internal sealed record DeliveryResult(bool Delivered, string SinkReceipt);
