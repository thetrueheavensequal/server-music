import { getType } from "mime";
import { Context, IContext, Resource, Get, HttpException, Put, Before } from "@wellenline/via";
import { statSync, createReadStream } from "fs";
import { transcode } from "@src/common/library";
import { Track, TrackModel } from "@src/models/track";
import { onScrobble } from "@src/providers/lastfm";
import { Can } from "@src/middleware/access";
import { LikeModel } from "@src/models/like";
import { ChartModel } from "@src/models/chart";
import { Album } from "@src/models/album";
export interface ITrackQueryOptions {
	skip?: number;
	limit?: number;
	genre?: string;
	liked?: boolean | string;
	sort?: string;
	artist?: string;
	album?: string;
	popular?: boolean;
	artists?: string;

}
@Resource("/tracks")
export class Tracks {
	@Get("/")
	@Before(Can("read:track"))
	public async tracks(@Context() context: IContext) {
		const { skip, limit, genre, liked, sort, artist, album, popular }: ITrackQueryOptions = context.query;


		const query: any = {};
		const sort_by: { field?: string } = {
			field: sort || "-created_at",
		};

		if (genre) {
			query.genre = genre;
		}

		if (liked === "true") {
			const data = await LikeModel.find({ created_by: context.payload.id });
			if (data.length > 0) {
				query._id = { $in: data.map(l => l.track) };
			}
		}

		if (artist) {
			query.artists = artist;
		}

		if (album) {
			query.album = album;
			sort_by.field = "number";
		}

		if (popular) {
			query.plays = {
				$gte: 10,
			};
		}


		const tracks = await TrackModel.find(query).sort(sort_by.field).populate([{
			path: "album",
			populate: [{
				path: "artist",
			}],
		}, {
			path: "genre",
		}, {
			path: "artists",

		}]).skip(skip || 0).limit(limit || 20);

		const total = await TrackModel.countDocuments(query);

		return {
			data: tracks, /*  await Promise.all(tracks.map(async (track) => {
				track.liked = !!(await LikeModel.findOne({ created_by: context.payload.id, track: track._id }));
				return track;
			})),
			*/
			metadata: {
				...query,
				skip,
				limit,
				sort
			},
			total,
		};
	}


	@Get("/play/:id")
	// @Before(Can())
	public async stream(@Context() context: IContext) {
		const track = await TrackModel.findById(context.params.id);
		if (!track) {
			throw new Error("Failed to load track metadata");
		}
		/*track.plays = parseInt(track.plays as any, 10) + 1;
		track.last_play = new Date();

		await track.save();*/
		// wait until audio has finished transcodig... probably not the best way of doing it
		if (track.path.toString().endsWith(".flac") && context.query.transcode) {
			track.path = await transcode(track as any, {
				output: { type: "mp3" }
			});
		}

		const stat = statSync(track.path);

		const total = stat.size;

		if (context.req.headers.range) {
			const range = context.req.headers.range;
			const parts = range.replace(/bytes=/, "").split("-");
			const partialstart = parseInt(parts[0], 10);
			const partialend = parseInt(parts[1], 10);

			const start = partialstart;
			const end = partialend ? partialend : total - 1;
			const chunksize = (end - start) + 1;


			context.status = 206;
			context.headers = {
				"Content-Range": "bytes " + start + "-" + end + "/" + total,
				"Accept-Ranges": "bytes", "Content-Length": chunksize,
				"Content-Type": getType(track.path) || "audio/mp3",
			};

			return createReadStream(track.path, { start, end });
		} else {

			context.headers = {
				"Content-Type": getType(track.path) || "audio/mp3",
				"Accept-Ranges": "bytes",
				"Content-Length": stat.size,
			};

			return createReadStream(track.path);
		}

	}

	@Get("/like/:id")
	@Before(Can("read:track"))
	public async like(@Context() context: IContext) {
		return await TrackModel.like(context.params.id, context.payload.id);
	}


	@Get("/random")
	@Before(Can("read:track"))
	public async random(@Context() context: IContext) {
		return await TrackModel.random(context.query.total);
	}


	@Put(`/plays/:id`)
	@Before(Can())
	public async create(@Context() context: IContext) {
		const track = await TrackModel.findById(context.params.id).populate("album");
		if (!track) {
			throw new Error("Failed to load track metadata");
		}
		track.plays = parseInt(track.plays as any, 10) + 1;
		track.last_play = new Date();

		await track.save();

		ChartModel.log({
			track: track._id,
			artist: (track.album as Album).artist?.toString(),
			album: (track.album as any)._id.toString(),
			genre: track.genre?.toString(),
			created_by: context.payload.id,
		});

		// scrobble
		onScrobble(track);
		return {
			success: true,
		};
	}
}
