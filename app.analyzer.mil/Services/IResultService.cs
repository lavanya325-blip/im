using Prodigy.ElectronUI.Core.DTOs;
using app.analyzer.mil.DTOs;
using Prodigy.Protos;

namespace app.analyzer.mil.Services
{
    public interface IResultService
    {
        long GetCount(string protocolName);
        //Task<IEnumerable<ProtocolFrameDto>> GetMessages(RequestMessages requestMessages, CancellationToken cancellationToken);
        Task<IEnumerable<string>> GetRawMessages(RequestMessages requestMessages, CancellationToken cancellationToken);

        Task<BusResponse> GetBus(RequestBus request, CancellationToken cancellationToken);
        Task<EdgeResponse> GetEdges(RequestEdges request, CancellationToken cancellationToken);
        Task<PlotInfoDto> GetPlotInfo(CancellationToken cancellationToken);
        long GetTriggerIndex();
    }
}
