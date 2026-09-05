using System.Runtime.InteropServices;

namespace DesktopBridge.Native;

internal sealed class SendInputBackend : IInputBackend
{
    public string SinkReceipt => "win-sendinput";

    public InputBackendResult TapKey(ValidatedKeyTap key)
    {
        uint commonFlags = key.Extended
            ? NativeMethods.KeyeventfExtendedKey
            : 0;
        var inputs = new[]
        {
            new Input
            {
                Type = NativeMethods.InputKeyboard,
                Data = new InputUnion
                {
                    Keyboard = new KeyboardInput
                    {
                        VirtualKey = key.VirtualKey,
                        Flags = commonFlags,
                    },
                },
            },
            new Input
            {
                Type = NativeMethods.InputKeyboard,
                Data = new InputUnion
                {
                    Keyboard = new KeyboardInput
                    {
                        VirtualKey = key.VirtualKey,
                        Flags = commonFlags | NativeMethods.KeyeventfKeyup,
                    },
                },
            },
        };

        return SendOnce(inputs);
    }

    public InputBackendResult Click(ValidatedMouseClick click)
    {
        var inputs = new[]
        {
            new Input
            {
                Type = NativeMethods.InputMouse,
                Data = new InputUnion
                {
                    Mouse = new MouseInput
                    {
                        Dx = click.NormalizedX,
                        Dy = click.NormalizedY,
                        Flags = NativeMethods.MouseeventfMove |
                            NativeMethods.MouseeventfAbsolute |
                            NativeMethods.MouseeventfVirtualdesk,
                    },
                },
            },
            new Input
            {
                Type = NativeMethods.InputMouse,
                Data = new InputUnion
                {
                    Mouse = new MouseInput
                    {
                        Flags = NativeMethods.MouseeventfLeftdown,
                    },
                },
            },
            new Input
            {
                Type = NativeMethods.InputMouse,
                Data = new InputUnion
                {
                    Mouse = new MouseInput
                    {
                        Flags = NativeMethods.MouseeventfLeftup,
                    },
                },
            },
        };

        return SendOnce(inputs);
    }

    internal static InputBackendResult ClassifyAcceptedCount(
        uint accepted,
        uint expected)
    {
        if (accepted == 0)
        {
            return new InputBackendResult(InputBackendOutcome.NotDelivered);
        }

        return accepted == expected
            ? new InputBackendResult(InputBackendOutcome.Delivered)
            : new InputBackendResult(InputBackendOutcome.DeliveryUnknown);
    }

    private static InputBackendResult SendOnce(Input[] inputs)
    {
        uint accepted = NativeMethods.SendInput(
            (uint)inputs.Length,
            inputs,
            Marshal.SizeOf<Input>());
        return ClassifyAcceptedCount(accepted, (uint)inputs.Length);
    }
}
