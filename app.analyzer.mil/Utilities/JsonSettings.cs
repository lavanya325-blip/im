using Prodigy.ElectronUI.Core.JsonConverters;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace app.analyzer.mil.Utilities;

internal static class JsonSettings
{
    public static readonly JsonSerializerOptions Options = GetOptions();

    private static JsonSerializerOptions GetOptions()
    {
        var options = new JsonSerializerOptions()
        {
            PropertyNamingPolicy = null,
            TypeInfoResolver = AppJsonContext.Default,
            NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        options.Converters.Add(new ByteStringJsonConverter());
        options.Converters.Add(new AnyJsonConverter());

        return options;
    }

    private static JsonSerializerOptions GetCustomOptions(JsonSerializerContext context)
    {
        var options = new JsonSerializerOptions()
        {
            PropertyNamingPolicy = null,
            TypeInfoResolver = context,
            NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };
        options.Converters.Add(new ByteStringJsonConverter());

        return options;
    }

    public static readonly JsonSerializerOptions DecoderOptions = GetCustomOptions(AppDecoderJsonContext.Default);
}
