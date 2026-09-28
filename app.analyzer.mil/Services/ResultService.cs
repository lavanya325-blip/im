using System.Net.Http.Json;
using app.analyzer.mil.Utilities;
using Prodigy.ElectronUI.Core.DTOs;
using Prodigy.Protos;

namespace app.analyzer.mil.Services;

internal sealed class ResultService : IResultService
{
    private readonly HttpClient _http;

    public ResultService(HttpClient http) => _http = http;

    public long GetCount(string protocolName)
        => GetCountAsync(protocolName).GetAwaiter().GetResult();

    public async Task<long> GetCountAsync(string protocolName, CancellationToken cancellationToken = default)
    {
        var response = await _http.GetAsync($"/result/count?protocolName={protocolName}", cancellationToken);
        response.EnsureSuccessStatusCode();

        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        return long.Parse(text);
    }

    public async Task<IEnumerable<string>> GetRawMessages(RequestMessages requestMessages, CancellationToken cancellationToken)
        => await (await _http.PostAsJsonAsync("/result/messages", requestMessages, JsonSettings.Options, cancellationToken))
            .Content.ReadFromJsonAsync<string[]>(JsonSettings.DecoderOptions, cancellationToken)
            ?? Array.Empty<string>();

    public async Task<PlotInfoDto> GetPlotInfo(CancellationToken cancellationToken)
        => await _http.GetFromJsonAsync<PlotInfoDto>("/result/plotinfo", cancellationToken)
            ?? throw new InvalidOperationException("Plot info response was empty.");

    public async Task<BusResponse> GetBus(RequestBus request, CancellationToken cancellationToken)
        => await (await _http.PostAsJsonAsync("/result/Bus", request, JsonSettings.Options, cancellationToken))
            .Content.ReadFromJsonAsync<BusResponse>(JsonSettings.Options, cancellationToken)
            ?? throw new InvalidOperationException("Bus response was empty.");

    public async Task<EdgeResponse> GetEdges(RequestEdges request, CancellationToken cancellationToken)
        => await (await _http.PostAsJsonAsync("/result/Edges", request, JsonSettings.Options, cancellationToken))
            .Content.ReadFromJsonAsync<EdgeResponse>(JsonSettings.Options, cancellationToken)
            ?? throw new InvalidOperationException("Edge response was empty.");

    public long GetTriggerIndex()
        => GetTriggerIndexAsync().GetAwaiter().GetResult();

    public async Task<long> GetTriggerIndexAsync(CancellationToken cancellationToken = default)
        => await _http.GetFromJsonAsync<long>("/result/TriggerIndex", cancellationToken);
}
