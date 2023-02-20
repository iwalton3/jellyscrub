using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using System.Globalization;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging;
using Nick.Plugin.Jellyscrub.Configuration;
using System.Text.Json;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Configuration;
using SkiaSharp;

namespace Nick.Plugin.Jellyscrub.Drawing;

public class VideoProcessor
{
    private readonly ILogger<VideoProcessor> _logger;
    private readonly IFileSystem _fileSystem;
    private readonly IApplicationPaths _appPaths;
    private readonly ILibraryMonitor _libraryMonitor;
    private readonly PluginConfiguration _config;
    private readonly OldMediaEncoder _oldEncoder;

    public VideoProcessor(
        ILoggerFactory loggerFactory,
        ILogger<VideoProcessor> logger,
        IMediaEncoder mediaEncoder,
        IServerConfigurationManager configurationManager,
        IFileSystem fileSystem,
        IApplicationPaths appPaths,
        ILibraryMonitor libraryMonitor,
        EncodingHelper encodingHelper)
    {
        _logger = logger;
        _fileSystem = fileSystem;
        _appPaths = appPaths;
        _libraryMonitor = libraryMonitor;
        _config = JellyscrubPlugin.Instance!.Configuration;
        _oldEncoder = new OldMediaEncoder(loggerFactory.CreateLogger<OldMediaEncoder>(), mediaEncoder, configurationManager, fileSystem, encodingHelper);
    }

    /*
     * Entry point to tell VideoProcessor to generate preview images from item
     */
    public async Task Run(BaseItem item, CancellationToken cancellationToken)
    {
        var mediaSources = ((IHasMediaSources)item).GetMediaSources(false)
            .ToList();

        foreach (var mediaSource in mediaSources)
        {
            foreach (var width in _config.WidthResolutions)
            {
                /*
                 * It seems that in Jellyfin multiple files in the same folder exist both as separate items
                 * and as sub-media sources under a single head item. Because of this, it is worth a simple check
                 * to make sure we are not writing a "sub-items" trickplay data to the metadata folder of the "main" item.
                 */
                if (!item.Id.Equals(Guid.Parse(mediaSource.Id))) continue;

                cancellationToken.ThrowIfCancellationRequested();

                var config = new TileManifest{
                    Width = width,
                    TileWidth = _config.TileWidth,
                    TileHeight = _config.TileHeight,
                    Interval = _config.Interval,
                };
                await Run(item, mediaSource, config, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private async Task Run(BaseItem item, MediaSourceInfo mediaSource, TileManifest config, CancellationToken cancellationToken)
    {
        if (!HasTiles(item, _fileSystem, config.Width))
        {
            await TilesWriterSemaphore.WaitAsync(cancellationToken).ConfigureAwait(false);

            try
            {
                if (!HasTiles(item, _fileSystem, config.Width))
                {
                    // Note: CreateTiles updates the config with additional information
                    await CreateTiles(item, config, mediaSource, cancellationToken).ConfigureAwait(false);
                    await CreateManifest(item, config).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error while creating preview images");
            }
            finally
            {
                TilesWriterSemaphore.Release();
            }
        }
    }

    /*
     * Methods for getting storage paths of Manifest files
     */
    private bool HasManifest(BaseItem item, IFileSystem fileSystem)
    {
        return !string.IsNullOrWhiteSpace(GetExistingManifestPath(item, fileSystem));
    }

    private static string GetNewManifestPath(BaseItem item)
    {
        return JellyscrubPlugin.Instance!.Configuration.LocalMediaFolderSaving ? GetLocalManifestPath(item) : GetInternalManifestPath(item);
    }

    public static string? GetExistingManifestPath(BaseItem item, IFileSystem fileSystem)
    {
        var path = JellyscrubPlugin.Instance!.Configuration.LocalMediaFolderSaving ? GetLocalManifestPath(item) : GetInternalManifestPath(item);

        return fileSystem.FileExists(path) ? path : null;
    }

    private static string GetLocalManifestPath(BaseItem item)
    {
        var folder = Path.Combine(item.ContainingFolderPath, "trickplay");
        var filename = Path.GetFileNameWithoutExtension(item.Path);
        filename += "-" + "manifest.json";

        return Path.Combine(folder, filename);
    }

    private static string GetInternalManifestPath(BaseItem item)
    {
        return Path.Combine(item.GetInternalMetadataPath(), "trickplay", "manifest.json");
    }

    /*
     * Manifest Creation
     */
    private async Task CreateManifest(BaseItem item, TileManifest config)
    {
        // Create Manifest object with new resolution
        Manifest newManifest = new Manifest() {
            Version = JellyscrubPlugin.Instance!.Version.ToString(),
            WidthResolutions = new Dictionary<int, TileManifest>() { { config.Width, config } }
        };

        // If a Manifest object already exists, combine resolutions
        var path = GetNewManifestPath(item);
        if (HasManifest(item, _fileSystem))
        {
            using FileStream openStream = File.OpenRead(path);
            Manifest? oldManifest = await JsonSerializer.DeserializeAsync<Manifest>(openStream);

            if (oldManifest != null && oldManifest.WidthResolutions != null)
            {
                newManifest.WidthResolutions[config.Width] = config;
            }
        }

        // Serialize and write to manifest file
        using FileStream createStream = File.Create(path);
        await JsonSerializer.SerializeAsync(createStream, newManifest);
        await createStream.DisposeAsync();
    }

    /*
     * Methods for getting storage paths of preview images
     */
    private bool HasTiles(BaseItem item, IFileSystem fileSystem, int width)
    {
        return !string.IsNullOrWhiteSpace(GetExistingTilesPath(item, fileSystem, width));
    }

    public static string? GetExistingTilesPath(BaseItem item, IFileSystem fileSystem, int width)
    {
        var path = JellyscrubPlugin.Instance!.Configuration.LocalMediaFolderSaving ? GetLocalTilesPath(item, width) : GetInternalTilesPath(item, width);

        return fileSystem.DirectoryExists(path) ? path : null;
    }

    public static string? GetExistingTilesPlaylistPath(BaseItem item, IFileSystem fileSystem, int width)
    {
        var path = Path.Join(GetExistingTilesPath(item, fileSystem, width), $"tiles.m3u8");

        return fileSystem.FileExists(path) ? path : null;
    }

    public static string? GetExistingTilePath(BaseItem item, IFileSystem fileSystem, int width, int tileId)
    {
        var path = Path.Join(GetExistingTilesPath(item, fileSystem, width), $"{tileId}.jpg");

        return fileSystem.FileExists(path) ? path : null;
    }

    private static string GetNewTilesPath(BaseItem item, int width)
    {
        return JellyscrubPlugin.Instance!.Configuration.LocalMediaFolderSaving ? GetLocalTilesPath(item, width) : GetInternalTilesPath(item, width);
    }

    private static string GetLocalTilesPath(BaseItem item, int width)
    {
        var folder = Path.Combine(item.ContainingFolderPath, "trickplay");
        var filename = Path.GetFileNameWithoutExtension(item.Path);
        filename += "-" + width.ToString(CultureInfo.InvariantCulture);

        return Path.Combine(folder, filename);
    }

    private static string GetInternalTilesPath(BaseItem item, int width)
    {
        return Path.Combine(item.GetInternalMetadataPath(), "trickplay", width.ToString(CultureInfo.InvariantCulture));
    }

    /*
     * Tiles Creation
     */
    private static readonly SemaphoreSlim TilesWriterSemaphore = new SemaphoreSlim(1, 1);

    private Task CreateTiles(BaseItem item, TileManifest config, MediaSourceInfo mediaSource, CancellationToken cancellationToken)
    {
        var path = GetNewTilesPath(item, config.Width);

        return CreateTiles(path, config, item, mediaSource, cancellationToken);
    }

    private async Task CreateTiles(string path, TileManifest config, BaseItem item, MediaSourceInfo mediaSource, CancellationToken cancellationToken)
    {
        _logger.LogInformation("Creating trickplay files at {0} width, for {1} [ID: {2}]", config.Width, mediaSource.Path, item.Id);

        var protocol = mediaSource.Protocol;

        var tempDirectory = Path.Combine(_appPaths.TempDirectory, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDirectory);

        try
        {
            var videoStream = mediaSource.VideoStream;

            var inputPath = mediaSource.Path;

            await _oldEncoder.ExtractVideoImagesOnInterval(inputPath, mediaSource.Container, videoStream, mediaSource, mediaSource.Video3DFormat,
                    TimeSpan.FromMilliseconds(config.Interval), tempDirectory, "img_", config.Width, cancellationToken)
                    .ConfigureAwait(false);

            var images = _fileSystem.GetFiles(tempDirectory, new string[] { ".jpg" }, false, false)
                .Where(img => string.Equals(img.Extension, ".jpg", StringComparison.Ordinal))
                .OrderBy(i => i.FullName)
                .ToList();

            if (images.Count == 0) throw new InvalidOperationException("Cannot make preview images from 0 images.");

            var tilesTempPath = Path.Combine(tempDirectory, Guid.NewGuid().ToString("N"));

            await CreateTiles(tilesTempPath, images, config).ConfigureAwait(false);

            _libraryMonitor.ReportFileSystemChangeBeginning(path);

            try
            {
                Directory.CreateDirectory(Directory.GetParent(path)!.FullName);

                // replace existing tile sets if they exist
                if (Directory.Exists(path))
                    Directory.Delete(path, true);

                MoveDirectory(tilesTempPath, path);

                // Create .ignore file so trickplay folder is not picked up as a season when TV folder structure is improper.
                var ignorePath = Path.Combine(Directory.GetParent(path)!.FullName, ".ignore");
                if (!File.Exists(ignorePath)) await File.Create(ignorePath).DisposeAsync();

                _logger.LogInformation("Finished creation of trickplay tiles {0}", path);
            }
            finally
            {
                _libraryMonitor.ReportFileSystemChangeComplete(path, false);
            }
        }
        finally
        {
            DeleteDirectory(tempDirectory);
        }
    }

    public async Task CreateTiles(string directoryPath, List<FileSystemMetadata> images, TileManifest config)
    {
        Directory.CreateDirectory(directoryPath);

        var i = 0;
        config.TileCount = images.Count;

        using StreamWriter tilePlaylist = new StreamWriter(Path.Join(directoryPath, "tiles.m3u8"));
        int totalImageCount = (int) Math.Ceiling((decimal)images.Count / config.TileWidth / config.TileHeight);
        await tilePlaylist.WriteAsync($"#EXTM3U\n#EXT-X-TARGETDURATION:{totalImageCount}\n#EXT-X-VERSION:7\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-IMAGES-ONLY\n\n");

        var firstImg = SKBitmap.Decode(images[0].FullName);
        if (firstImg == null) {
            throw new Exception("Could not decode image data.");
        }

        config.Height = firstImg.Height;
        if (config.Width != firstImg.Width) {
            throw new Exception("Image width does not match config width.");
        }

        var imgNo = 1;
        while (i < images.Count)
        {
            var tileSet = new SKBitmap(config.Width * config.TileWidth, config.Height.Value * config.TileHeight);
            var tileCount = 0;

            using (var canvas = new SKCanvas(tileSet))
            {
                for (var y = 0; y < config.TileHeight; y++)
                {
                    for (var x = 0; x < config.TileWidth; x++)
                    {
                        if (i >= images.Count) break;

                        var img = SKBitmap.Decode(images[i].FullName);
                        if (img == null) {
                            throw new Exception("Could not decode image data.");
                        }

                        if (config.Width != img.Width) {
                            throw new Exception("Image width does not match config width.");
                        }

                        if (config.Height != img.Height) {
                            throw new Exception("Image height does not match first image height.");
                        }

                        canvas.DrawBitmap(img, x * config.Width, y * config.Height.Value);
                        tileCount++;
                        i++;
                    }
                }
            }

            var tileSetPath = Path.Combine(directoryPath, $"{imgNo}.jpg");
            using (var stream = File.OpenWrite(tileSetPath))
            {
                tileSet.Encode(stream, SKEncodedImageFormat.Jpeg, _config.JpegQuality);
            }

            var tileSetDuration = Math.Ceiling((decimal)config.Interval*tileCount / 1000);
            var tileDuration = Math.Ceiling((decimal)config.Interval / 1000);
            await tilePlaylist.WriteAsync($"#EXTINF:{tileSetDuration},\n#EXT-X-TILES:RESOLUTION={config.Width}x{config.Height.Value},LAYOUT={config.TileWidth}x{config.TileHeight},DURATION={tileDuration}\n{imgNo}.jpg\n");

            imgNo++;
        }

        await tilePlaylist.WriteAsync("\n#EXT-X-ENDLIST\n");
    }

    /*
     * Utility Methods
     */
    private void DeleteDirectory(string directory)
    {
        try
        {
            Directory.Delete(directory, true);
        }
        catch (Exception ex)
        {
            _logger.LogError("Error deleting {0}: {1}", ex, directory);
        }
    }

    private void MoveDirectory(string source, string destination)
    {
        try {
            Directory.Move(source, destination);
        } catch (System.IO.IOException) {
            // Cross device move requires a copy
            Directory.CreateDirectory(destination);
            foreach (string file in Directory.GetFiles(source))
                File.Copy(file, Path.Join(destination, Path.GetFileName(file)), true);
            Directory.Delete(source, true);
        }
    }
}
