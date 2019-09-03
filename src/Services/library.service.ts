import * as crypto from "crypto";
import * as fs from "fs";
import * as mm from "music-metadata";
import * as path from "path";
import { SpotifyService } from "./spotify.service";

import { ArtistModel, Artist } from "../Models/artist.model";
import { GenreModel, Genre } from "../Models/genre.model";
import { TrackModel } from "../Models/track.model";
import { AlbumModel } from "../Models/album.model";
import { InfoModel } from "../Models/info.model";
import albumArt = require("album-art");
import axios from "axios";

/**
 * Library Service
 */
export class LibraryService {
	private bytes = 0;

	public async extractMetadata(files: any) {
		try {
			const tracks = [];
			const capitalize = (string: string) => {
				return string ? string.toLowerCase()
					.split(" ")
					.map((s: string) => s.charAt(0).toUpperCase() + s.substring(1))
					.join(" ") : string;
			};

			for (let file of files) {
				let genre: Genre | any;
				const exists = await TrackModel.findOne({ path: file });
				if (!exists) {
					const metadata = await mm.parseFile(file);

					const artists = await ArtistModel.findOrCreate(metadata.common.artists.length > 1 ? metadata.common.artists : metadata.common.artist.split(","));

					const albumArtist = artists.find((artist) => artist.name === capitalize(metadata.common.albumartist));

					const album = await AlbumModel.findOrCreate(metadata.common.album, {
						name: albumArtist.name,
						id: albumArtist._id,
					});

					console.log("Artists", artists);

					console.log("Album", album);
					// console.log(metadata);

					const albumArtID = crypto.createHash("md5").update(`${metadata.common.albumartist}-${metadata.common.album}`).digest("hex");
					// 	console.log(metadata, albumArtID);
					/*const id = crypto.createHash("md5").update(`${metadata.common.albumartist}-${metadata.common.album}`).digest("hex");

					// Create artist
					let artist = await ArtistModel.findOne({ name: capitalize(metadata.common.artist) });
					if (!artist) {
						const data: { name?: string, picture?: string, created_at?: Date } = {
							name: capitalize(metadata.common.artist),
							created_at: new Date(),
						};

						try {
							if (process.env.SPOTIFY_ID && process.env.SPOTIFY_SECRET) {
								const spotifyArtist = await new Spotify().search("artist", metadata.common.artist);
								console.dir(spotifyArtist.artists.items);
								if (spotifyArtist && spotifyArtist.artists && spotifyArtist.artists.items && spotifyArtist.artists.items.length > 0) {
									data.picture = spotifyArtist.artists.items[0].images[0] ? spotifyArtist.artists.items[0].images[0].url : "";
								}
							}
						} catch (e) {
							console.info(e);
						}

						console.info("Creating new artist");
						console.dir(data);
						artist = await ArtistModel.create(data);
					}

					// Create genre
					if (metadata.common.genre) {
						genre = await GenreModel.findOne({ name: metadata.common.genre[0] });
						if (!genre) {
							genre = await GenreModel.create({ name: metadata.common.genre[0] });
						}
					}

					// Create new album
					let album = await AlbumModel.findOne({ name: metadata.common.album });
					if (!album) {
						if (metadata.common.picture && metadata.common.picture.length > 0) {
							fs.writeFileSync(`${process.env.ART_PATH}/${id}`, metadata.common.picture[0].data);
						} else {

							try {
								if (process.env.SPOTIFY_ID && process.env.SPOTIFY_SECRET) {
									const spotifyAlbum = await new Spotify().search("album", `album:${metadata.common.album} artist:${metadata.common.artist}`);
									console.dir(spotifyAlbum.albums.items);
									if (spotifyAlbum && spotifyAlbum.albums && spotifyAlbum.albums.items && spotifyAlbum.albums.items.length > 0) {
										const link = spotifyAlbum.albums.items[0].images[0] ? spotifyAlbum.albums.items[0].images[0].url : false;

										if (link) {
											await this.download(link, `${process.env.ART_PATH}/${id}`);
										}
									}
								}
							} catch (e) {
								console.info(e);
							}

							const link = await albumArt(metadata.common.artist, {
								album: metadata.common.album,
							});

							if (link) {
								await this.download(link, `${process.env.ART_PATH}/${id}`);
							}
						}
						album = await AlbumModel.create({ name: metadata.common.album, artist: artist._id, art: id, created_at: new Date() });
					}

					// Create track
					let track = await TrackModel.findOne({ title: metadata.common.title, artist: artist._id, album: album._id });

					if (!track) {
						track = await TrackModel.create({
							title: metadata.common.title,
							artist: artist._id,
							album: album._id,
							art: id,
							genre: genre ? genre._id : undefined,
							duration: metadata.format.duration,
							path: file,
							created_at: new Date(),
						});
					}

					tracks.push(track);
*/
				}
			}

			return tracks;
		} catch (e) {
			console.info(e);
			throw e;
		}
	}

	public download(url: any, file: fs.PathLike) {
		axios({
			url,
			responseType: "stream",
		}).then(
			(response) =>
				new Promise((resolve, reject) => {
					response.data
						.pipe(fs.createWriteStream(file))
						.on("finish", () => resolve())
						.on("error", (e: any) => reject(e));
				}),
		);
	}

	/**
	 * Sync music library
	 * @param path music directory
	 * @param ext extensions to look for
	 */
	public async sync(path: string, ext: string[]) {
		try {
			if (!fs.existsSync(process.env.ART_PATH || "art")) {
				fs.mkdirSync(process.env.ART_PATH || "art");
			}

			const files = await this.get_files(path).filter((file) => ext.some((e) => file.includes(e)));

			const start = new Date();
			await this.extractMetadata(files);

			const end = new Date();
			const data = {
				start,
				end,
				seconds: (end.getTime() - start.getTime()) / 1000,
				tracks: await TrackModel.estimatedDocumentCount(),
				albums: await AlbumModel.estimatedDocumentCount(),
				artists: await ArtistModel.estimatedDocumentCount(),
				size: this.bytes,
				mount: path,
				last_scan: new Date(),
			};

			return await InfoModel.findOneAndUpdate({ last_scan: { $ne: undefined } }, data, {
				upsert: true,
				new: true,
			});
		} catch (e) {
			throw e;
		}
	}

	/**
	 * Get all files in folder
	 * @param dir path to walk
	 */
	private get_files(dir: fs.PathLike): string[] {
		return fs.readdirSync(dir).reduce((list, file) => {
			const name = path.join(dir as string, file);
			const stats = fs.statSync(name);
			if (stats.isDirectory()) {
				return list.concat(this.get_files(name));
			}

			if (stats.isFile()) {
				this.bytes += stats.size;
			}
			return list.concat([name]);
		}, []);
	}

}
