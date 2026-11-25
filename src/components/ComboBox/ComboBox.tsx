import React from "react";
import {
  debounce,
  getMediaPathResults,
  getYouTubeResults,
  isHttp,
  isMagnet,
  isYouTube,
} from "../../utils/utils";
import { examples } from "../../utils/examples";
import ChatVideoCard from "../ChatVideoCard/ChatVideoCard";
import { IconBrandYoutubeFilled, IconLink, IconX } from "@tabler/icons-react";
import {
  ActionIcon,
  Autocomplete,
  Loader,
  type AutocompleteProps,
} from "@mantine/core";

type ComboBoxProps = {
  roomSetMedia: (value: string) => void;
  playlistAdd: (value: string) => void;
  roomMedia: string;
  getMediaDisplayName: (input: string) => string;
  mediaPath: string | undefined;
  disabled?: boolean;
};

type ComboBoxState = {
  inputMedia?: string;
  items: SearchResult[];
  loading: boolean;
  // The text YouTube was last searched for (the results in items belong to it)
  searchedQuery?: string;
  dropdownOpen: boolean;
};

// Dropdown entry that runs the YouTube search: typing alone never searches
const SEARCH_YOUTUBE_ITEM = "\u0000search-youtube";

// Anything that is not a URL or magnet link is a YouTube search term
const isPlainText = (value: string | undefined): value is string =>
  Boolean(value) && !isHttp(value as string) && !isMagnet(value as string);

export class ComboBox extends React.Component<ComboBoxProps, ComboBoxState> {
  state: ComboBoxState = {
    inputMedia: undefined as string | undefined,
    items: [] as SearchResult[],
    loading: false,
    searchedQuery: undefined as string | undefined,
    dropdownOpen: false,
  };

  searchingQuery: string | undefined = undefined;

  setMediaAndClose = (value: string) => {
    this.props.roomSetMedia(value);
    this.setState({ inputMedia: undefined, items: [] });
  };

  doSearch = async () => {
    const value = this.state.inputMedia;
    const query: string = value || "";
    if (isPlainText(query)) {
      // Plain text is only searched on YouTube by an explicit action
      this.setState({ loading: false });
      return;
    }
    this.setState({ loading: true });
    let items = examples;
    try {
      if (!value && this.props.mediaPath) {
        items = await getMediaPathResults(this.props.mediaPath, "");
      }
      if (query) {
        let type: SearchResult["type"] = "file";
        if (isYouTube(query)) {
          type = "youtube";
        }
        if (isMagnet(query)) {
          type = "magnet";
        }
        // Create entry from user input
        items = [
          {
            name: query,
            type,
            url: query,
            duration: 0,
          },
        ];
      }
    } catch {
      // A failed lookup must not leave the spinner running forever
    }
    this.setState({
      loading: false,
      items,
    });
  };

  searchYouTube = async () => {
    const query = this.state.inputMedia;
    if (!isPlainText(query) || this.searchingQuery === query) {
      return;
    }
    this.searchingQuery = query;
    this.setState({ loading: true });
    let items: SearchResult[] = [];
    try {
      items = await getYouTubeResults(query);
    } catch {
      // A failed lookup must not leave the spinner running forever
    }
    if (this.searchingQuery === query) {
      this.searchingQuery = undefined;
    }
    if (this.state.inputMedia !== query) {
      // Typed on meanwhile: these results belong to older text
      this.setState({ loading: this.searchingQuery !== undefined });
      return;
    }
    this.setState({
      loading: false,
      items,
      searchedQuery: query,
      dropdownOpen: true,
    });
  };

  debouncedSearch = debounce(this.doSearch);

  onChange = (value: string) => {
    if (value === SEARCH_YOUTUBE_ITEM) {
      // Picking the search entry must not put its marker into the input
      return;
    }
    if (isPlainText(value)) {
      this.setState({ inputMedia: value, items: [], searchedQuery: undefined });
    } else {
      this.setState({ inputMedia: value }, this.debouncedSearch);
    }
  };

  render() {
    const { roomMedia: currentMedia, getMediaDisplayName } = this.props;
    const renderOption: AutocompleteProps["renderOption"] = ({ option }) => {
      if (option.value === SEARCH_YOUTUBE_ITEM) {
        return (
          <div
            key={option.value}
            onClick={() => this.searchYouTube()}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <IconBrandYoutubeFilled size={20} />
            <span>Search YouTube for “{this.state.inputMedia}”</span>
          </div>
        );
      }
      const video = this.state.items.find((item) => item.url === option.value);
      return (
        <div
          key={option.value}
          onClick={(e) => this.setMediaAndClose(option.value)}
          style={{ width: "100%" }}
        >
          {video && (
            <ChatVideoCard
              video={video}
              index={0}
              onPlaylistAdd={this.props.playlistAdd}
            />
          )}
        </div>
      );
    };
    return (
      <Autocomplete
        maxDropdownHeight={400}
        style={{ width: "100%" }}
        disabled={this.props.disabled}
        onChange={this.onChange}
        dropdownOpened={this.state.dropdownOpen}
        onDropdownOpen={() => this.setState({ dropdownOpen: true })}
        onDropdownClose={() => this.setState({ dropdownOpen: false })}
        onFocus={(e: any) => {
          const focusedMedia =
            isHttp(currentMedia) || isMagnet(currentMedia)
              ? currentMedia
              : getMediaDisplayName(currentMedia);
          this.setState(
            {
              // Display the real string value (currentMedia) when focused
              inputMedia: focusedMedia,
              // The shown title is not something the user typed to search for
              searchedQuery: focusedMedia,
            },
            () => {
              if (
                !this.state.inputMedia ||
                (this.state.inputMedia &&
                  (isHttp(this.state.inputMedia) ||
                    isMagnet(this.state.inputMedia)))
              ) {
                this.doSearch();
              }
              e.target.select();
            },
          );
        }}
        onBlur={() => {
          this.setState({
            inputMedia: undefined,
            items: [],
            searchedQuery: undefined,
          });
        }}
        onKeyDown={(e: any) => {
          if (e.key === "Enter") {
            if (isPlainText(this.state.inputMedia)) {
              this.searchYouTube();
              return;
            }
            this.setMediaAndClose(this.state.inputMedia ?? "");
            e.target.blur();
          }
        }}
        rightSection={
          <ActionIcon
            color="red"
            onClick={(e: any) => this.setMediaAndClose("")}
            title="Clear"
            aria-label="Clear"
          >
            <IconX />
          </ActionIcon>
        }
        leftSection={this.state.loading ? <Loader size="sm" /> : <IconLink />}
        placeholder="Enter video file URL, magnet link, YouTube link, or YouTube search term"
        value={
          this.state.inputMedia !== undefined
            ? this.state.inputMedia
            : getMediaDisplayName(currentMedia)
        }
        renderOption={renderOption}
        data={
          isPlainText(this.state.inputMedia) &&
          this.state.searchedQuery !== this.state.inputMedia
            ? [SEARCH_YOUTUBE_ITEM]
            : this.state.items.map((item) => item.url)
        }
        filter={({ options }) => options}
      />
    );
  }
}
