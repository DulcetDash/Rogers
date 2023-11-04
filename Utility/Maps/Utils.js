/* eslint-disable import/prefer-default-export */
import axios from 'axios';
import { logger } from '../../LogService';

/**
 * Responsible for finding vital ETA and route informations from one point
 * to another.
 * @param simplifiedResults: to only return the ETA and distance infos
 */
export async function getItinaryInformation(
    coordsInfos,
    simplifiedResults = false
) {
    try {
        const destinationPosition = coordsInfos.destination;
        const passengerPosition = coordsInfos.passenger;
        //! APPLY BLUE OCEAN BUG FIX FOR THE PICKUP LOCATION COORDINATES
        //? 1. Destination
        //? Get temporary vars
        const pickLatitude1 = parseFloat(destinationPosition.latitude);
        const pickLongitude1 = parseFloat(destinationPosition.longitude);
        //! Coordinates order fix - major bug fix for ocean bug
        if (
            pickLatitude1 &&
            pickLatitude1 !== 0 &&
            pickLongitude1 &&
            pickLongitude1 !== 0
        ) {
            //? Switch latitude and longitude - check the negative sign
            if (parseFloat(pickLongitude1) < 0) {
                //Negative - switch
                destinationPosition.latitude = pickLongitude1;
                destinationPosition.longitude = pickLatitude1;
            }
        }
        //? 2. Passenger
        //? Get temporary vars
        const pickLatitude2 = parseFloat(passengerPosition.latitude);
        const pickLongitude2 = parseFloat(passengerPosition.longitude);
        //! Coordinates order fix - major bug fix for ocean bug
        if (
            pickLatitude2 &&
            pickLatitude2 !== 0 &&
            pickLongitude2 &&
            pickLongitude2 !== 0
        ) {
            //? Switch latitude and longitude - check the negative sign
            if (parseFloat(pickLongitude2) < 0) {
                //Negative - switch
                passengerPosition.latitude = pickLongitude2;
                passengerPosition.longitude = pickLatitude2;
            }
        }
        //!!! --------------------------
        let url = `${process.env.URL_ROUTE_SERVICES}point=${passengerPosition.latitude},${passengerPosition.longitude}&point=${destinationPosition.latitude},${destinationPosition.longitude}&heading_penalty=0&avoid=residential&avoid=ferry&ch.disable=true&locale=en&details=street_name&details=time&optimize=true&points_encoded=false&details=max_speed&snap_prevention=ferry&profile=car&pass_through=true`;

        logger.info(url);
        //Add instructions if specified so
        if (coordsInfos?.setIntructions) {
            url += '&instructions=true';
        } //Remove instructions details
        else {
            url += '&instructions=false';
        }

        const route = await axios.get(url);
        const body = route.data;

        if (!body?.paths?.[0]?.distance) return false;

        const { distance } = body.paths[0];
        const eta =
            body.paths[0].time / 1000 >= 60
                ? `${Math.round(body.paths[0].time / 60000)} min away`
                : `${Math.round(body.paths[0].time / 1000)} sec away`; //Sec

        if (!simplifiedResults) {
            const rawPoints = body.paths[0].points.coordinates;
            const pointsTravel = rawPoints;

            return {
                routePoints: pointsTravel,
                driverNextPoint: pointsTravel[0],
                destinationPoint: [
                    destinationPosition.longitude,
                    destinationPosition.latitude,
                ],
                instructions: coordsInfos.setIntructions
                    ? body.paths[0].instructions
                    : null,
                eta: eta,
                distance: distance,
            };
        }

        //Simplified results
        return {
            eta: eta,
            distance: distance,
        };
    } catch (error) {
        logger.error(error);
        return false;
    }
}
