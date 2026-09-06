using System.Buffers.Binary;
using System.Text.Json;

namespace DesktopBridge.Native;

internal static class SelfTests
{
    public static int Run(TextWriter diagnostics)
    {
        var tests = new (string Name, Action Body)[]
        {
            ("rejects malformed JSON", RejectsMalformedJson),
            ("rejects unknown fields", RejectsUnknownFields),
            ("rejects duplicate fields", RejectsDuplicateFields),
            ("rejects zero-sized bound clients", RejectsZeroSizedBoundClients),
            ("rejects non-allowlisted key before OS input", RejectsNonAllowlistedKey),
            ("uses half-open region containment", UsesHalfOpenRegionContainment),
            ("encodes deterministic PNG dimensions", EncodesDeterministicPng),
            ("routes validated values through fake backends once", RoutesValidatedValuesThroughFakeBackendsOnce),
            ("preserves the key allowlist with explicit scan codes", PreservesKeyAllowlistWithScanCodes),
            ("builds physical scan-code key down and up packets", BuildsPhysicalScanCodePackets),
            ("rejects invalid frame backend IDs without retry", RejectsInvalidFrameBackendIdsWithoutRetry),
            ("maps SendInput zero and partial counts conservatively", MapsSendInputCountsConservatively),
            ("maps fake backend failures without retry", MapsFakeBackendFailuresWithoutRetry),
        };

        int failures = 0;
        foreach ((string name, Action body) in tests)
        {
            try
            {
                body();
                diagnostics.WriteLine($"PASS {name}");
            }
            catch (Exception ex)
            {
                failures++;
                diagnostics.WriteLine($"FAIL {name}: {ex.Message}");
            }
        }

        diagnostics.WriteLine($"{tests.Length - failures}/{tests.Length} native self-tests passed.");
        return failures == 0 ? 0 : 1;
    }

    private static void RejectsMalformedJson()
    {
        AssertFailureCode(
            BridgeProtocol.ProcessLine("{"),
            "INVALID_JSON");
    }

    private static void RejectsUnknownFields()
    {
        AssertFailureCode(
            BridgeProtocol.ProcessLine(
                """{"id":"test","op":"listWindows","extra":true}"""),
            "INVALID_REQUEST");
    }

    private static void RejectsDuplicateFields()
    {
        AssertFailureCode(
            BridgeProtocol.ProcessLine(
                """{"id":"test","id":"duplicate","op":"listWindows"}"""),
            "INVALID_REQUEST");
    }

    private static void RejectsNonAllowlistedKey()
    {
        const string binding =
            """
            {
              "hwnd":"1",
              "pid":1,
              "processStartTimeUtc":"2026-01-01T00:00:00.0000000Z",
              "executableSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "clientWidth":100,
              "clientHeight":100
            }
            """;
        string request =
            $$"""{"id":"test","op":"tapKey","binding":{{binding}},"code":"Escape"}""";
        AssertFailureCode(
            BridgeProtocol.ProcessLine(request),
            "KEY_NOT_ALLOWED");
    }

    private static void RejectsZeroSizedBoundClients()
    {
        const string request =
            """
            {
              "id":"test",
              "op":"capture",
              "binding":{
                "hwnd":"1",
                "pid":1,
                "processStartTimeUtc":"2026-01-01T00:00:00.0000000Z",
                "executableSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "clientWidth":0,
                "clientHeight":100
              },
              "region":{"x":0,"y":0,"width":1,"height":1}
            }
            """;
        AssertFailureCode(
            BridgeProtocol.ProcessLine(request),
            "INVALID_REQUEST");
    }

    private static void UsesHalfOpenRegionContainment()
    {
        var region = new CaptureRegion(10, 20, 30, 40);
        BridgeProtocol.ValidatePointInRegion(new ClientPoint(10, 20), region);
        BridgeProtocol.ValidatePointInRegion(new ClientPoint(39, 59), region);

        bool rejected = false;
        try
        {
            BridgeProtocol.ValidatePointInRegion(new ClientPoint(40, 59), region);
        }
        catch (RequestException ex) when (ex.Code == "INVALID_POINT")
        {
            rejected = true;
        }

        Assert(rejected, "right edge must be excluded");
    }

    private static void EncodesDeterministicPng()
    {
        byte[] bgra =
        {
            0x00, 0x00, 0xff, 0x00,
            0x00, 0xff, 0x00, 0x00,
        };
        byte[] png = PngEncoder.EncodeBgra32(bgra, 2, 1);
        byte[] signature =
        {
            137, 80, 78, 71, 13, 10, 26, 10,
        };

        Assert(png.AsSpan(0, 8).SequenceEqual(signature), "PNG signature mismatch");
        Assert(
            BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(16, 4)) == 2,
            "PNG width mismatch");
        Assert(
            BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(20, 4)) == 1,
            "PNG height mismatch");
        Assert(png[24] == 8 && png[25] == 2, "PNG must be 8-bit RGB");
    }

    private static void RoutesValidatedValuesThroughFakeBackendsOnce()
    {
        byte[] png = PngEncoder.EncodeBgra32(
            new byte[] { 0x00, 0x00, 0xff, 0x00 },
            1,
            1);
        var frameBackend = new FakeFrameCaptureBackend(
            "fake-capture/v1",
            _ => png);
        var captureRegion = new ValidatedCaptureRegion(10, 20, 1, 1);
        CapturedFrame captured = BackendDispatch.Capture(
            frameBackend,
            captureRegion);
        Assert(frameBackend.Calls == 1, "frame backend must be called once");
        Assert(
            frameBackend.LastRegion == captureRegion,
            "frame backend must receive only the validated screen region");
        Assert(
            captured.BackendId == "fake-capture/v1" &&
            captured.PngBytes.AsSpan().SequenceEqual(png),
            "frame backend result mismatch");

        var inputBackend = new FakeInputBackend(
            "fake-input",
            _ => new InputBackendResult(InputBackendOutcome.Delivered),
            _ => new InputBackendResult(InputBackendOutcome.Delivered));
        var key = new ValidatedKeyTap(0x1E, false);
        DeliveryResult keyDelivery = BackendDispatch.TapKey(inputBackend, key);
        Assert(inputBackend.TapCalls == 1, "key backend must be called once");
        Assert(
            inputBackend.LastKey == key,
            "input backend must receive only the validated key");
        Assert(
            keyDelivery == new DeliveryResult(true, "fake-input"),
            "key delivery result mismatch");

        var click = new ValidatedMouseClick(12_345, 54_321);
        DeliveryResult clickDelivery = BackendDispatch.Click(
            inputBackend,
            click);
        Assert(inputBackend.ClickCalls == 1, "click backend must be called once");
        Assert(
            inputBackend.LastClick == click,
            "input backend must receive only the validated normalized point");
        Assert(
            clickDelivery == new DeliveryResult(true, "fake-input"),
            "click delivery result mismatch");
    }

    private static void PreservesKeyAllowlistWithScanCodes()
    {
        var expected = new Dictionary<string, ValidatedKeyTap>(StringComparer.Ordinal)
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

        foreach ((string code, ValidatedKeyTap expectedTap) in expected)
        {
            Assert(
                WindowsDesktop.TryResolveAllowedKey(code, out ValidatedKeyTap actualTap),
                $"{code} must remain allowlisted");
            Assert(actualTap == expectedTap, $"{code} scan-code mapping mismatch");
        }

        Assert(
            !WindowsDesktop.TryResolveAllowedKey("Escape", out _),
            "non-allowlisted keys must remain rejected");
    }

    private static void BuildsPhysicalScanCodePackets()
    {
        AssertScanCodePackets(new ValidatedKeyTap(0x1E, false));
        AssertScanCodePackets(new ValidatedKeyTap(0x48, true));
    }

    private static void AssertScanCodePackets(ValidatedKeyTap key)
    {
        Input[] inputs = SendInputBackend.BuildKeyTapInputs(key);
        Assert(inputs.Length == 2, "a key tap must contain exactly down and up");

        uint downFlags = NativeMethods.KeyeventfScancode |
            (key.Extended ? NativeMethods.KeyeventfExtendedKey : 0);
        uint upFlags = downFlags | NativeMethods.KeyeventfKeyup;
        AssertKeyboardInput(inputs[0], key.ScanCode, downFlags, "key down");
        AssertKeyboardInput(inputs[1], key.ScanCode, upFlags, "key up");
    }

    private static void AssertKeyboardInput(
        Input input,
        ushort scanCode,
        uint expectedFlags,
        string phase)
    {
        KeyboardInput keyboard = input.Data.Keyboard;
        Assert(input.Type == NativeMethods.InputKeyboard, $"{phase} type mismatch");
        Assert(keyboard.VirtualKey == 0, $"{phase} wVk must be zero");
        Assert(keyboard.ScanCode == scanCode, $"{phase} scan code mismatch");
        Assert(keyboard.Flags == expectedFlags, $"{phase} flags mismatch");
        Assert(keyboard.Time == 0, $"{phase} time must use the system default");
        Assert(keyboard.ExtraInfo == 0, $"{phase} extra info must be zero");
    }

    private static void RejectsInvalidFrameBackendIdsWithoutRetry()
    {
        byte[] png = PngEncoder.EncodeBgra32(
            new byte[] { 0x00, 0x00, 0xff, 0x00 },
            1,
            1);
        string[] invalidBackendIds =
        {
            string.Empty,
            " fake-capture/v1",
            "fake capture/v1",
            @"C:\private",
            "../provider",
            "fake\ncapture/v1",
            "é",
            new string('a', 129),
        };

        foreach (string backendId in invalidBackendIds)
        {
            var backend = new FakeFrameCaptureBackend(
                backendId,
                _ => png);
            AssertRequestCode(
                () => BackendDispatch.Capture(
                    backend,
                    new ValidatedCaptureRegion(0, 0, 1, 1)),
                "CAPTURE_FAILED");
            Assert(
                backend.Calls == 1,
                $"invalid backend ID must not retry capture: {backendId.Length}");
        }
    }

    private static void MapsSendInputCountsConservatively()
    {
        Assert(
            SendInputBackend.ClassifyAcceptedCount(0, 2).Outcome ==
                InputBackendOutcome.NotDelivered,
            "zero accepted events must be NOT_DELIVERED");
        Assert(
            SendInputBackend.ClassifyAcceptedCount(1, 2).Outcome ==
                InputBackendOutcome.DeliveryUnknown,
            "partial accepted events must be DELIVERY_UNKNOWN");
        Assert(
            SendInputBackend.ClassifyAcceptedCount(2, 2).Outcome ==
                InputBackendOutcome.Delivered,
            "all accepted events must be DELIVERED");
        Assert(
            SendInputBackend.ClassifyAcceptedCount(3, 2).Outcome ==
                InputBackendOutcome.DeliveryUnknown,
            "invalid accepted counts must be DELIVERY_UNKNOWN");
    }

    private static void MapsFakeBackendFailuresWithoutRetry()
    {
        var notDelivered = new FakeInputBackend(
            "fake-input",
            _ => new InputBackendResult(InputBackendOutcome.NotDelivered),
            _ => throw new InvalidOperationException("not used"));
        AssertRequestCode(
            () => BackendDispatch.TapKey(
                notDelivered,
                new ValidatedKeyTap(0x1E, false)),
            "INPUT_NOT_DELIVERED");
        Assert(
            notDelivered.TapCalls == 1,
            "NOT_DELIVERED must not be retried");

        var partial = new FakeInputBackend(
            "fake-input",
            _ => new InputBackendResult(InputBackendOutcome.DeliveryUnknown),
            _ => throw new InvalidOperationException("not used"));
        AssertRequestCode(
            () => BackendDispatch.TapKey(
                partial,
                new ValidatedKeyTap(0x1E, false)),
            "DELIVERY_UNKNOWN");
        Assert(
            partial.TapCalls == 1,
            "DELIVERY_UNKNOWN must not be retried");

        var throwing = new FakeInputBackend(
            "fake-input",
            _ => throw new InvalidOperationException("fake failure"),
            _ => throw new InvalidOperationException("not used"));
        AssertRequestCode(
            () => BackendDispatch.TapKey(
                throwing,
                new ValidatedKeyTap(0x1E, false)),
            "DELIVERY_UNKNOWN");
        Assert(
            throwing.TapCalls == 1,
            "input backend exceptions must not be retried");

        var incompleteCapture = new FakeFrameCaptureBackend(
            "fake-capture/v1",
            _ => Array.Empty<byte>());
        AssertRequestCode(
            () => BackendDispatch.Capture(
                incompleteCapture,
                new ValidatedCaptureRegion(0, 0, 1, 1)),
            "CAPTURE_FAILED");
        Assert(
            incompleteCapture.Calls == 1,
            "incomplete captures must not be retried");

        var throwingCapture = new FakeFrameCaptureBackend(
            "fake-capture/v1",
            _ => throw new InvalidOperationException("fake failure"));
        AssertRequestCode(
            () => BackendDispatch.Capture(
                throwingCapture,
                new ValidatedCaptureRegion(0, 0, 1, 1)),
            "CAPTURE_FAILED");
        Assert(
            throwingCapture.Calls == 1,
            "capture backend exceptions must not be retried");
    }

    private static void AssertFailureCode(string response, string expectedCode)
    {
        using JsonDocument document = JsonDocument.Parse(response);
        JsonElement root = document.RootElement;
        Assert(root.EnumerateObject().Count() == 3, "failure envelope must have exactly three fields");
        Assert(!root.GetProperty("ok").GetBoolean(), "failure response must set ok=false");
        JsonElement error = root.GetProperty("error");
        Assert(error.EnumerateObject().Count() == 2, "error must have exactly two fields");
        Assert(
            error.GetProperty("code").GetString() == expectedCode,
            $"expected {expectedCode}");
    }

    private static void AssertRequestCode(Action action, string expectedCode)
    {
        try
        {
            action();
        }
        catch (RequestException ex)
        {
            Assert(
                ex.Code == expectedCode,
                $"expected {expectedCode}, received {ex.Code}");
            return;
        }

        throw new InvalidOperationException(
            $"expected {expectedCode}");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private sealed class FakeFrameCaptureBackend : IFrameCaptureBackend
    {
        private readonly Func<ValidatedCaptureRegion, byte[]> capture;

        public FakeFrameCaptureBackend(
            string backendId,
            Func<ValidatedCaptureRegion, byte[]> capture)
        {
            BackendId = backendId;
            this.capture = capture;
        }

        public string BackendId { get; }

        public int Calls { get; private set; }

        public ValidatedCaptureRegion? LastRegion { get; private set; }

        public byte[] Capture(ValidatedCaptureRegion region)
        {
            Calls++;
            LastRegion = region;
            return capture(region);
        }
    }

    private sealed class FakeInputBackend : IInputBackend
    {
        private readonly Func<ValidatedKeyTap, InputBackendResult> tapKey;
        private readonly Func<ValidatedMouseClick, InputBackendResult> click;

        public FakeInputBackend(
            string sinkReceipt,
            Func<ValidatedKeyTap, InputBackendResult> tapKey,
            Func<ValidatedMouseClick, InputBackendResult> click)
        {
            SinkReceipt = sinkReceipt;
            this.tapKey = tapKey;
            this.click = click;
        }

        public string SinkReceipt { get; }

        public int TapCalls { get; private set; }

        public int ClickCalls { get; private set; }

        public ValidatedKeyTap? LastKey { get; private set; }

        public ValidatedMouseClick? LastClick { get; private set; }

        public InputBackendResult TapKey(ValidatedKeyTap key)
        {
            TapCalls++;
            LastKey = key;
            return tapKey(key);
        }

        public InputBackendResult Click(ValidatedMouseClick clickValue)
        {
            ClickCalls++;
            LastClick = clickValue;
            return click(clickValue);
        }
    }
}
