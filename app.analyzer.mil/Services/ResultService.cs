using Prodigy.ElectronUI.Core.DTOs;
using Prodigy.ElectronUI.Core.Extensions;
using Prodigy.ElectronUI.Core.Interfaces;
using app.analyzer.mil.DTOs;
using app.analyzer.mil.Extensions;
using app.analyzer.mil.Utilities;
using Google.Protobuf.Reflection;
using Microsoft.Extensions.DependencyInjection;
using Prodigy.Common.ProtoActors.Events;
using Prodigy.Protos;
using System.Diagnostics;

namespace app.analyzer.mil.Services;

/// <summary>
/// Keep trace of results
/// </summary>
public class ResultService : IResultService
{
    private readonly Google.Protobuf.JsonFormatter formatter;
    private readonly IServiceProvider serviceProvider;
    private readonly IAppConnectionProvider appConnectionProvider;
    private readonly IEventStream eventStream;
    private readonly IViewService viewService;
    private readonly AppConfigurationService configurationService;
    private IConformanceService conformanceService;
    private PlotInfoDto plotInfo = new();
    private bool autoSetReferenceTime = false;
    private double? referenceTime = null;
    private CancellationTokenSource triggerSearchCts = new();
    private long? triggerPacketIndex = null;

    public ResultService(
        IServiceProvider serviceProvider,
        TypeRegistry typeRegistry,
        IAppConnectionProvider appConnectionProvider,
        IEventStream eventStream,
        IViewService viewService,
        AppConfigurationService configurationService)
    {
        formatter = new Google.Protobuf.JsonFormatter(new Google.Protobuf.JsonFormatter.Settings(true, typeRegistry).WithPreserveProtoFieldNames(true));
        this.serviceProvider = serviceProvider;
        this.appConnectionProvider = appConnectionProvider;
        this.eventStream = eventStream;
        this.viewService = viewService;
        this.configurationService = configurationService;

        eventStream.Subscribe<SystemStatusUpdate>(OnSystemStatusUpdate);
        eventStream.Subscribe<MessagesAvailableResponse>(OnMessageAvailableUpdated);
        eventStream.Subscribe<HardwareStatus>(OnHardwareStatusUpdated);
        eventStream.Subscribe<EdgesAvailableResponse>(OnEdgesAvailableUpdated);
    }

    private Task OnSystemStatusUpdate(SystemStatusUpdate update)
    {
        switch (update.CurrentState)
        {
            case SystemStates.CleanupRun:

                try
                {
                    // cancell trigger search
                    triggerSearchCts.Cancel();
                }
                catch { }

                lock (plotInfo)
                {
                    triggerPacketIndex = null;
                    referenceTime = null;
                    plotInfo.StartTime = 0;
                    plotInfo.EndTime = 0;
                    plotInfo.ReferenceStartTime = 0;
                    plotInfo.AvailableChannels = [];
                }
                break;
            case SystemStates.InitializeRun:

                triggerSearchCts = new();
                lock (plotInfo)
                {
                    if (configurationService.Configuration.TriggerConfig.TriggerType == TriggerType.Auto)
                        autoSetReferenceTime = true;
                    else
                        autoSetReferenceTime = false;

                    Channels[] channels = [configurationService.Configuration.SCL, .. configurationService.Configuration.SDAs];

                    foreach (var channel in channels)
                        plotInfo.AvailableChannels[channel] = 0;
                }

                break;
        }

        return Task.CompletedTask;
    }

    private Task OnEdgesAvailableUpdated(EdgesAvailableResponse response)
    {
        lock (plotInfo)
        {
            plotInfo.StartTime = response.StartTime;
            plotInfo.EndTime = response.EndTime;

            foreach (var channelUpdate in response.ChannelEdgeAvailable)
                plotInfo.AvailableChannels[channelUpdate.Channel] = channelUpdate.Count;
        }

        return Task.CompletedTask;
    }

    private async Task OnMessageAvailableUpdated(MessagesAvailableResponse response)
    {
        if (autoSetReferenceTime && referenceTime.HasValue == false)
        {
            if (response.ProtocolName == configurationService.Configuration.ProtocolName && response.TotalMessages > 0)
            {
                var messagesResponse = await this.GetMessagesInternal(new RequestMessages { ProtocolName = response.ProtocolName, IndexBased = new IndexBasedDataSubset { Offset = 0, Count = 1 } }, CancellationToken.None);

                if (messagesResponse.Messages.Count > 0)
                {
                    referenceTime = messagesResponse.Messages[0].StartTime;
                    lock (plotInfo) { plotInfo.ReferenceStartTime = referenceTime.Value; }

                    // Publish event -> 1st message time will be set as reference time
                    eventStream.Publish(new AutoReferenceTimeDto { ReferenceTime = referenceTime.Value });
                }
            }
        }
    }

    private Task OnHardwareStatusUpdated(HardwareStatus status)
    {
        // When manual trigger is set, do not raise event
        if (status.StatusType == HardwareStatusType.TriggerFound && autoSetReferenceTime == false && referenceTime.HasValue == false)
        {
            Trace.WriteLine("Trigger found");
            lock (plotInfo)
            {
                referenceTime = status.Timestamp;
                plotInfo.ReferenceStartTime = referenceTime.Value;

                // Search for trigger index
                Task.Run(async () =>
                {
                    try
                    {
                        Trace.WriteLine("Trigger found -> searching for trigger packet");
                        var index = await SearchTriggerFrame.SearchTriggerIndex(this.GetOrCreateConnection(), eventStream, configurationService.Configuration.ProtocolName, referenceTime.Value, triggerSearchCts.Token);

                        lock (plotInfo)
                            this.triggerPacketIndex = index;

                        // Publish event to client about index updated
                        eventStream.Publish(new TriggerIndexUpdateDto { TriggerIndex = index });
                    }
                    catch { }
                });
            }
        }

        return Task.CompletedTask;
    }

    private IAppConnection GetOrCreateConnection() => appConnectionProvider.GetOrCreate("ResultService");

    public long GetCount(string protocolName) => viewService.GetMessageCount(protocolName);

    public async Task<IEnumerable<string>> GetRawMessages(RequestMessages requestMessages, CancellationToken cancellationToken)
    {
        var response = await GetMessagesInternal(requestMessages, cancellationToken);

        return response.Messages.Select(m => formatter.Format(m));
    }

    public async Task<IEnumerable<ProtocolFrameDto>> GetMessages(RequestMessages request, CancellationToken cancellationToken)
    {
        var response = await GetMessagesInternal(request, cancellationToken);

        var dtos = response.Messages.Select(m => m.ToDTO());

        if (request.RequestCase == RequestMessages.RequestOneofCase.IndexBased)
        {
            var offset = (int)request.IndexBased.Offset;
            var count = response.Messages.Count;
            dtos = dtos.Zip(Enumerable.Range(offset, count), (r, i) =>
            {
                r.Index = i;

                if (triggerPacketIndex.HasValue && triggerPacketIndex == i)
                    r.IsTriggerFrame = true;

                return r;
            });

            conformanceService = conformanceService ?? serviceProvider.GetService<IConformanceService>()!;
            var testIds = conformanceService?.GetResultTestId(offset, count) ?? [];
            if (testIds.Any())
            {
                dtos = dtos.Zip(testIds, (r, t) =>
                {
                    if (t.HasValue)
                    {
                        r.TestId = t.Value.TestId;

                        // update error packet
                        var errorList = t.Value.TestStatus.FrameErrors.Where(e => e.FrameIndex == r.Index);
                        if (errorList.Any())
                        {
                            r.HasTestError = true;
                            foreach (var frame in errorList)
                            {
                                if (frame.PacketIndex >= 0 && frame.PacketIndex < r.Packets.Count)
                                    r.Packets[(int)frame.PacketIndex].HasTestError = true;
                            }
                        }
                    }

                    return r;
                });
            }
        }

        return dtos;
    }

    public long GetTriggerIndex() => (autoSetReferenceTime || this.triggerPacketIndex.HasValue == false) ? -1 : this.triggerPacketIndex.Value;

    private Task<MessagesResponse> GetMessagesInternal(RequestMessages request, CancellationToken cancellationToken)
    {
        if (configurationService.Configuration.ProtocolName != request.ProtocolName && viewService.GetViewNames().Contains(request.ProtocolName) == false)
            throw new ArgumentException($"View name [{request.ProtocolName}] not found");

        return GetOrCreateConnection().Request<MessagesResponse>(request, cancellationToken);
    }

    public Task<BusResponse> GetBus(RequestBus request, CancellationToken cancellationToken)
    {
        return GetOrCreateConnection().Request<BusResponse>(request, cancellationToken);
    }

    public Task<EdgeResponse> GetEdges(RequestEdges request, CancellationToken cancellationToken)
    {
        return GetOrCreateConnection().Request<EdgeResponse>(request, cancellationToken);
    }

    public Task<PlotInfoDto> GetPlotInfo(CancellationToken cancellationToken)
    {
        lock (plotInfo)
        {
            return Task.FromResult((PlotInfoDto)plotInfo.Clone());
        }
    }
}
