using Prodigy.ElectronUI.Core.DTOs;
using Prodigy.Protos;

namespace app.analyzer.mil.Services;

internal interface IResultService
{
    Task<BusResponse> GetBus(RequestBus request, CancellationToken cancellationToken);

    long GetCount(string protocolName);

    Task<EdgeResponse> GetEdges(RequestEdges request, CancellationToken cancellationToken);

    Task<PlotInfoDto> GetPlotInfo(CancellationToken cancellationToken);

    Task<IEnumerable<string>> GetRawMessages(RequestMessages requestMessages, CancellationToken cancellationToken);

    long GetTriggerIndex();
}
