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
            //TypeInfoResolver = AppJsonContext.Default,
            NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        options.Converters.Add(new ByteStringJsonConverter());
        options.Converters.Add(new AnyJsonConverter());

        // Add all types here that are possible in CtsSetupRequest
        //options.Converters.Add(new PolymorphicConverter<CtsSetupRequest>(
        //    typeMaps: new()
        //    {
        //        { "i3ctestconfig", AppJsonContext.Default.I3CTestConfig },
        //        { "mctptestconfig", AppJsonContext.Default.MCTPTestConfig },
        //        { "spdmtestconfig", AppJsonContext.Default.SPDMTestConfig }
        //    },
        //    rootTypeInfo: AppJsonContext.Default.CtsSetupRequest
        //    )
        //{

        //});

        // Add all types here that are possible in CtsTestCaseRequest
        //options.Converters.Add(new PolymorphicConverter<CtsTestCaseRequest>(
        //    typeMaps: new()
        //    {
        //        { "i3ctestrequest", AppJsonContext.Default.I3CTestRequest },
        //        { "mctptestrequest", AppJsonContext.Default.MCTPTestRequest },
        //        { "spdmtestrequest", AppJsonContext.Default.SPDMTestRequest }
        //    },
        //    rootTypeInfo: AppJsonContext.Default.CtsTestCaseRequest
        //    ));

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

    //public static readonly JsonSerializerOptions DecoderOptions = GetCustomOptions(AppDecoderJsonContext.Default);
}
