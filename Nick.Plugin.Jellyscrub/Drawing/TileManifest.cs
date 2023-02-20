namespace Nick.Plugin.Jellyscrub.Drawing;

public class TileManifest
{
    /// <summary>
    /// Width of an individual tile.
    /// </summary>
    public int Width { get; set; }
    /// <summary>
    /// Height of an individual tile.
    /// NOTE: This is a calculated field.
    /// </summary>
    public int? Height { get; set; }
    /// <summary>
    /// Maximum of tiles in the X direction.
    /// </summary>
    public int TileWidth { get; set; }
    /// <summary>
    /// Maximum of tiles in the Y direction.
    /// </summary>
    public int TileHeight { get; set; }
    /// <summary>
    /// Total number of tiles across all files.
    /// NOTE: This is a calculated field.
    /// </summary>
    public int? TileCount { get; set; }
    /// <summary>
    /// Interval, in ms, between each new trickplay image.
    /// </summary>
    public int Interval { get; set; }
}
