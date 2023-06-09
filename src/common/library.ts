import { AlbumModel } from "@src/models/album";
import { ArtistModel } from "@src/models/artist";
import { GenreModel } from "@src/models/genre";
import { Scan, ScanModel } from "@src/models/scan";
import { Track, TrackModel } from "@src/models/track";
import { watch as dirWatch } from "chokidar";
import { createReadStream, createWriteStream, existsSync, mkdirSync, Stats, statSync } from "fs";
import { parseFile } from "music-metadata";
import { extname } from "path";
import ProgressBar from "progress";
import Sox, { SoxOptions } from "sox-stream";
import { format } from "util";


const library = {
	ext: [".mp3", ".flac", ".m4a"],
};

let timer: NodeJS.Timeout;
let tracks: any[] = [];
let size = 0;

/**
 * It takes a string, makes it lowercase, splits it into an array of words, capitalizes the first
 * letter of each word, and then joins the array back into a string
 * @param {string} string - string - The string to capitalize.
 * @returns A function that takes a string and returns a string.
 */
export function capitalize(string: string) {
	return string ? string.toLowerCase()
		.split(" ")
		.map((s: string) => s.charAt(0).toUpperCase() + s.substring(1))
		.join(" ") : string;
}

/**
 * It watches the music directory for new files and removes them from the library when they are deleted
 * @param {string[]} [ext] - An array of file extensions to watch for. If not provided, it will default
 * to the following:
 */
export function watch(ext?: string[]) {
	if (ext && ext.length > 0) {
		library.ext = ext;
	}

	dirWatch(process.env.MUSIC_PATH as string, {
		persistent: true,
		//  alwaysStat: true,
		// ignoreInitial: true,
	}).on("add", _onFileAdded).on("unlink", _onFileRemoved);
}

/**
 * It takes a track and some options, and returns a promise that resolves to the path of the transcoded
 * audio file
 * @param {Track} track - The track object that contains the path to the audio file.
 * @param {SoxOptions} options - {
 * @returns A promise that resolves to a string.
 */
export function transcode(track: Track, options: SoxOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		const audioFile = `${process.env.CACHE_PATH}/transcode/${(track as any).id}.mp3`;

		if (existsSync(audioFile)) {
			return resolve(audioFile);
		}

		const wstream = createWriteStream(audioFile);

		const rstream = createReadStream(track.path, { autoClose: true }).pipe(Sox(options)).pipe(wstream);

		rstream.on("finish", () => {
			resolve(audioFile);
		});

		rstream.on("error", (err: any) => {
			console.log("Failed to transcode audio", err);
			reject(err);
		});

	});
}

/**
 * It takes an array of file paths, parses the metadata of each file, and then creates a new document
 * in the database for each file
 * @param {string[]} files - string[] - An array of file paths to scan
 * @returns The return value is a promise that resolves to the updated scan document.
 */
export async function build(files: string[]) {
	if (!existsSync(`${process.env.CACHE_PATH as string}`)) {
		mkdirSync(`${process.env.CACHE_PATH as string}`);
	}

	if (!existsSync(`${process.env.CACHE_PATH as string}/album-art`)) {
		mkdirSync(`${process.env.CACHE_PATH as string}/album-art`);
	}

	if (!existsSync(`${process.env.CACHE_PATH as string}/transcode`)) {
		mkdirSync(`${process.env.CACHE_PATH as string}/transcode`);
	}

	const scan: any = {
		start: new Date(),
		mount: process.env.MUSIC_PATH,
		last_scan: new Date(),
		size,
	};

	const bar = new ProgressBar(":bar :current/:total ", {
		index: 0,
		total: files.length,
	} as ProgressBar.ProgressBarOptions);

	const logStream = createWriteStream("error_log.txt", { flags: "a" });
	console.log("Starting to build your music library");
	for (const file of files) {
		bar.tick();
		try {
			// console.log(metadata.common.track.no);

			const exists = await TrackModel.exists({ path: file });

			if (exists) {
				continue;
			}

			const metadata = await parseFile(file);

			if (!metadata || metadata.format.tagTypes?.length === 0) {
				throw new Error("Not metadata found");
			}


			const names = (metadata.common.artists || metadata.common.artist?.split(/[&,]+/) || [])
				.map((name) => name.split(/[&,]+/))
				.reduce((a, b) => [...a, ...b], [])
				.map((name) => name.trim());


			// Find or create new artist(s)
			const artists = await ArtistModel.findOrCreate(names);


			const pictures = metadata.common.picture || [];

			const albumItem = {
				album: metadata.common.album || "",
				artist: artists[0], // assume first artist is the album artist
				year: metadata.common.year || 1970,
				picture: pictures.length > 0 ? pictures[0].data : false,
			};

			// Find or create a new album
			const album = await AlbumModel.findOrCreate(albumItem);

			// Check if metadata contains genre data
			let genre: any = null;
			if (metadata.common.genre && metadata.common.genre[0]) {
				genre = await GenreModel.findOrCreate(metadata.common.genre[0]);
			}

			await TrackModel.findOrCreate({
				name: capitalize(metadata.common.title || ""),
				artists,
				album: album._id,
				artist: names.join(", "),
				genre: genre ? genre._id : undefined,
				number: metadata?.common?.track?.no || 1,
				duration: metadata.format.duration || 0,
				path: file,
				lossless: metadata.format.lossless || false,
				year: metadata.common.year || 0,
				created_at: new Date(),
				updated_at: new Date(),
			});

		} catch (err) {
			console.log(err);
			logStream.write(`${file}\n`);
			logStream.write(`[ERROR]: ${format(err)}\n\n`);
		}
	}

	logStream.end();

	scan.end = new Date();
	scan.seconds = (scan.end.getTime() - scan.start.getTime()) / 1000;
	scan.tracks = await TrackModel.countDocuments();
	scan.albums = await AlbumModel.countDocuments();
	scan.artists = await ArtistModel.countDocuments();
	console.log("Done building library");
	console.log(scan);

	return ScanModel.findOneAndUpdate({}, scan as Scan, {
		upsert: true,
		new: true,
	});
}

/**
 * It adds a file to the list of tracks to be added to the library, and if the list is not empty after
 * 3 seconds, it sorts the list by creation time and adds the tracks to the library
 * @param {string} path - The path of the file that was added.
 * @param {Stats} [stat] - Stats - The stats of the file that was added.
 */
export function _onFileAdded(path: string, stat?: Stats) {
	clearTimeout(timer);
	if (library.ext.includes(extname(path))) {
		if (!stat) {
			stat = statSync(path);
		}

		size += stat.size;
		tracks.push({ path, stat });
	}

	timer = setTimeout(() => {
		tracks = tracks.sort((a, b) => b.stat.ctime - a.stat.ctime).map((file) => file.path).reverse();
		build(tracks);
		tracks = [];

	}, 3000);
}

/**
 * > When a file is removed, delete the records from the database
 * @param {string} path - The path of the file that was removed.
 */
export function _onFileRemoved(path: string) {
	console.log(`TODO: delete records from db on file delete event`);
	console.log(`File ${path} has been removed`);
}
