using System.Text.Json;
using System.Text.Json.Serialization;

namespace app.analyzer.mil.Utilities;

internal static class JsonSettings
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
}
