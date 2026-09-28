using app.analyzer.mil.Utilities;
using Prodigy.ElectronUI.Core.DTOs;
using Prodigy.Protos;
using System.Net.Http.Json;

namespace app.analyzer.mil.Services
{
    internal class ResultService : IResultService
    {
        private readonly HttpClient _http;

        public ResultService(HttpClient http) => _http = http;

        public Task<BusResponse> GetBus(RequestBus request, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public long GetCount(string protocolName)
        {
            throw new NotImplementedException();
        }

        public async Task<EdgeResponse> GetEdges(RequestEdges request, CancellationToken cancellationToken)
            => await (await _http.PostAsJsonAsync("/result/Edges", request, JsonSettings.Options, cancellationToken))
                .Content.ReadFromJsonAsync<EdgeResponse>(JsonSettings.Options, cancellationToken)
                ?? throw new InvalidOperationException("Edge response was empty.");

        public Task<PlotInfoDto> GetPlotInfo(CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public Task<IEnumerable<string>> GetRawMessages(RequestMessages requestMessages, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public long GetTriggerIndex()
        {
            throw new NotImplementedException();
        }
    }
}
