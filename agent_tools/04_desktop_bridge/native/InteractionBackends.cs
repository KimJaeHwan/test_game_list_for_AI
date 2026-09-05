namespace DesktopBridge.Native;

// Backends receive only values that the common Windows target guard has already
// validated. Implementations must make at most one attempt and must not focus,
// retarget, retry, or inspect a target window.
internal interface IFrameCaptureBackend
{
    string BackendId { get; }

    byte[] Capture(ValidatedCaptureRegion region);
}

internal interface IInputBackend
{
    string SinkReceipt { get; }

    InputBackendResult TapKey(ValidatedKeyTap key);

    InputBackendResult Click(ValidatedMouseClick click);
}

internal readonly record struct ValidatedCaptureRegion(
    int ScreenX,
    int ScreenY,
    int Width,
    int Height);

internal readonly record struct ValidatedKeyTap(
    ushort VirtualKey,
    bool Extended);

internal readonly record struct ValidatedMouseClick(
    int NormalizedX,
    int NormalizedY);

internal enum InputBackendOutcome
{
    Invalid = 0,
    Delivered = 1,
    NotDelivered = 2,
    DeliveryUnknown = 3,
}

internal readonly record struct InputBackendResult(InputBackendOutcome Outcome);

internal readonly record struct CapturedFrame(
    byte[] PngBytes,
    string BackendId);

internal static class BackendDispatch
{
    private static readonly byte[] PngSignature =
    {
        137, 80, 78, 71, 13, 10, 26, 10,
    };

    public static CapturedFrame Capture(
        IFrameCaptureBackend backend,
        ValidatedCaptureRegion region)
    {
        try
        {
            byte[] png = backend.Capture(region);
            string backendId = backend.BackendId;
            if (png is null ||
                png.Length < PngSignature.Length ||
                !png.AsSpan(0, PngSignature.Length).SequenceEqual(PngSignature) ||
                !IsValidBackendId(backendId))
            {
                throw new InvalidOperationException(
                    "Frame capture backend returned an incomplete result.");
            }

            return new CapturedFrame(png, backendId);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"frame capture backend failed: {ex.GetType().Name}");
            throw new RequestException(
                "CAPTURE_FAILED",
                "Desktop pixels could not be captured.");
        }
    }

    private static bool IsValidBackendId(string value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 128)
        {
            return false;
        }

        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            bool alphaNumeric =
                character is >= 'a' and <= 'z' or
                >= 'A' and <= 'Z' or
                >= '0' and <= '9';
            bool providerPunctuation =
                index > 0 && character is ('.' or '_' or ':' or '/' or '-');
            if (!alphaNumeric && !providerPunctuation)
            {
                return false;
            }
        }

        return true;
    }

    public static DeliveryResult TapKey(
        IInputBackend backend,
        ValidatedKeyTap key)
    {
        return Deliver(
            backend,
            () => backend.TapKey(key),
            "The operating system did not accept the key tap.",
            "The key tap delivery outcome could not be determined.");
    }

    public static DeliveryResult Click(
        IInputBackend backend,
        ValidatedMouseClick click)
    {
        return Deliver(
            backend,
            () => backend.Click(click),
            "The operating system did not accept the click.",
            "The click delivery outcome could not be determined.");
    }

    private static DeliveryResult Deliver(
        IInputBackend backend,
        Func<InputBackendResult> deliverOnce,
        string notDeliveredMessage,
        string deliveryUnknownMessage)
    {
        InputBackendResult result;
        try
        {
            result = deliverOnce();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"input backend outcome unknown: {ex.GetType().Name}");
            throw new RequestException(
                "DELIVERY_UNKNOWN",
                deliveryUnknownMessage);
        }

        if (result.Outcome == InputBackendOutcome.NotDelivered)
        {
            throw new RequestException(
                "INPUT_NOT_DELIVERED",
                notDeliveredMessage);
        }

        if (result.Outcome != InputBackendOutcome.Delivered)
        {
            throw new RequestException(
                "DELIVERY_UNKNOWN",
                deliveryUnknownMessage);
        }

        string receipt;
        try
        {
            receipt = backend.SinkReceipt;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"input backend receipt unknown: {ex.GetType().Name}");
            throw new RequestException(
                "DELIVERY_UNKNOWN",
                deliveryUnknownMessage);
        }

        if (!IsValidReceipt(receipt))
        {
            throw new RequestException(
                "DELIVERY_UNKNOWN",
                deliveryUnknownMessage);
        }

        return new DeliveryResult(true, receipt);
    }

    private static bool IsValidReceipt(string value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 128)
        {
            return false;
        }

        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            bool alphaNumeric =
                character is >= 'a' and <= 'z' or
                >= 'A' and <= 'Z' or
                >= '0' and <= '9';
            if (!alphaNumeric &&
                (index == 0 || character is not ('.' or '_' or ':' or '-')))
            {
                return false;
            }
        }

        return true;
    }
}
